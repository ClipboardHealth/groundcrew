/**
 * Acquisition unit tests. These drive REAL source bundles written to an OS
 * tmpdir — node-shebang command scripts, exactly like a conformant bundle — and
 * spawn them for real (no process mocks). Every failure mapping the adapter
 * promises (nonzero exit, garbage stdout, protocol failure, timeout, spawn
 * failure, missing secret) is exercised against a live process, plus discovery
 * classification, env composition, the sandbox wrap seam, and read-only no-op.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverSources, SUPPORTED_PROTOCOL_VERSIONS } from "./discover.js";
import type { DiscoveredSource, DiscoveredSourceOk } from "./discover.js";
import { MissingSecretError, SourceProtocolError } from "./errors.js";
import { missingSecretError, openSource, SOURCE_SCRATCH_ENV } from "./openSource.js";
import type { SourceConfig, WrapCommand } from "./openSource.js";
import { parseManifest } from "./manifest.js";
import { probeSource } from "./probe.js";
import type { WritebackEvent } from "./protocol.js";
import { createSecretsResolver, parseDotenv } from "./secrets.js";

// Child bundle spawns need the real PATH/HOME (to find node and expand `~`);
// forwarding a curated parent env is the whole point of these tests.
// oxlint-disable-next-line node/no-process-env -- see above
const REAL_PATH = process.env["PATH"];
// oxlint-disable-next-line node/no-process-env -- see above
const REAL_HOME = process.env["HOME"];

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acq-test-"));
  temporaryRoots.push(root);
  return root;
}

/** A protocol script (contracts §4): reads one JSON on stdin, emits one result on stdout. */
function protocolScript(command: string): string {
  return [
    "#!/usr/bin/env node",
    '"use strict";',
    'const fs = require("node:fs");',
    `const COMMAND = ${JSON.stringify(command)};`,
    "const U = COMMAND.toUpperCase();",
    "let stdin = {};",
    'try { const raw = fs.readFileSync(0, "utf8"); stdin = raw.trim() === "" ? {} : JSON.parse(raw); } catch {}',
    "if (process.env.PROTOCOL_JOURNAL) {",
    "  fs.appendFileSync(process.env.PROTOCOL_JOURNAL, JSON.stringify({",
    "    command: COMMAND, stdin,",
    "    scratch: process.env." + SOURCE_SCRATCH_ENV + ",",
    "    env: {",
    "      OVERRIDE_ME: process.env.OVERRIDE_ME,",
    "      FROM_MANIFEST: process.env.FROM_MANIFEST,",
    "      MY_SECRET: process.env.MY_SECRET,",
    "      PARENT_LEAK: process.env.PARENT_LEAK,",
    "      HAS_PATH: Boolean(process.env.PATH),",
    "    },",
    "  }) + \"\\n\");",
    "}",
    "function emit(o) { process.stdout.write(JSON.stringify(o) + \"\\n\"); process.exit(0); }",
    "function fail(m) { emit({ ok: false, error: { message: m } }); }",
    "const exitCode = process.env[U + \"_EXIT\"];",
    "if (exitCode) { process.exit(Number(exitCode)); }",
    "if (process.env[U + \"_GARBAGE\"]) { process.stdout.write(\"not json at all\\n\"); process.exit(0); }",
    "if (process.env[U + \"_BADENVELOPE\"]) { emit({ hello: 1 }); }",
    "function run() {",
    "  if (process.env[U + \"_STDERR\"]) { process.stderr.write(\"diagnostic line\\n\"); }",
    "  if (process.env[U + \"_BADSHAPE\"]) { emit({ ok: true, data: { wrong: 1 } }); }",
    "  if (process.env[U + \"_FAIL\"]) { fail(COMMAND + \" failed knob\"); }",
    "  if (COMMAND === \"list\") { emit({ ok: true, data: { tasks: JSON.parse(process.env.TASKS || \"[]\") } }); }",
    "  if (COMMAND === \"get\") { const t = JSON.parse(process.env.TASKS || \"[]\").find((x) => x.id === stdin.id); if (!t) { fail(\"not found\"); } emit({ ok: true, data: { task: t } }); }",
    "  if (COMMAND === \"update\") {",
    "    const ev = stdin.event || {};",
    "    if (ev.type === \"claimed\") { const rej = (process.env.REJECT || \"\").split(\",\").filter(Boolean); if (rej.includes(stdin.id)) { emit({ ok: true, data: { result: \"rejected\", reason: \"contended\" } }); } }",
    "    emit({ ok: true, data: { result: \"ok\" } });",
    "  }",
    "}",
    "const sleep = process.env[U + \"_SLEEP\"];",
    "if (sleep) { setTimeout(run, Number(sleep)); } else { run(); }",
    "",
  ].join("\n");
}

interface BundleInput {
  readonly root: string;
  readonly parent?: string; // parent dir under root; default "task-sources"
  readonly name: string;
  readonly manifest?: unknown; // object serialized to source.json; string written raw
  readonly withUpdate?: boolean; // default true
  readonly badManifestJson?: string; // raw source.json overriding manifest
}

/** Writes a real bundle (source.json + node-shebang scripts) and returns its dir. */
function writeBundle(input: BundleInput): string {
  const parent = path.join(input.root, input.parent ?? "task-sources");
  const bundleDirectory = path.join(parent, input.name);
  fs.mkdirSync(bundleDirectory, { recursive: true });

  for (const command of ["list", "get", "update"]) {
    if (command === "update" && input.withUpdate === false) {
      continue;
    }

    const scriptPath = path.join(bundleDirectory, command);
    fs.writeFileSync(scriptPath, protocolScript(command));
    fs.chmodSync(scriptPath, 0o755);
  }

  const manifestPath = path.join(bundleDirectory, "source.json");
  if (input.badManifestJson === undefined) {
    const manifest = input.manifest ?? defaultManifest({ withUpdate: input.withUpdate !== false });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n");
  } else {
    fs.writeFileSync(manifestPath, input.badManifestJson);
  }

  return bundleDirectory;
}

function defaultManifest(input: { readonly withUpdate: boolean }): Record<string, unknown> {
  return {
    protocolVersion: 1,
    commands: {
      list: "./list",
      get: "./get",
      ...(input.withUpdate ? { update: "./update" } : {}),
    },
    environment: {},
  };
}

/** Discovers a single named bundle written under `root` and returns its `ok` entry. */
function discoverOk(input: { readonly root: string; readonly name: string }): DiscoveredSourceOk {
  const discovered = discoverSources({
    packageBundlesDirectory: path.join(input.root, "package"),
    userBundlesDirectory: path.join(input.root, "task-sources"),
  });
  const found = discovered.find((entry) => entry.name === input.name);
  if (found?.status !== "ok") {
    throw new Error(`expected an ok source named ${input.name}, got ${found?.status ?? "none"}`);
  }

  return found;
}

// --- manifest --------------------------------------------------------------

describe("parseManifest", () => {
  it("parses a valid manifest and applies list-field defaults", () => {
    const input = JSON.stringify({ protocolVersion: 1, commands: { list: "./list" } });

    const actual = parseManifest(input);

    expect(actual).toEqual({
      ok: true,
      manifest: {
        protocolVersion: 1,
        commands: { list: "./list" },
        secrets: [],
        environment: {},
        network: [],
        prerequisites: [],
      },
    });
  });

  it("rejects invalid JSON, naming source.json", () => {
    const actual = parseManifest("{ not json,,, ");

    expect(actual).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/source\.json is not valid JSON/),
    });
  });

  it("rejects a manifest missing the required list command", () => {
    const actual = parseManifest(JSON.stringify({ protocolVersion: 1, commands: {} }));

    expect(actual.ok).toBe(false);
  });

  it("rejects a non-integer protocolVersion", () => {
    const actual = parseManifest(
      JSON.stringify({ protocolVersion: 1.5, commands: { list: "./list" } }),
    );

    expect(actual.ok).toBe(false);
  });
});

// --- secrets ---------------------------------------------------------------

describe("parseDotenv", () => {
  it("parses keys, comments, exports, and quoted values", () => {
    const input = [
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=exported",
      'DOUBLE="a b\\nc"',
      "SINGLE='literal\\n'",
      "  SPACED = spaced ",
      "NOEQ",
    ].join("\n");

    const actual = parseDotenv(input);

    expect(actual).toEqual({
      PLAIN: "value",
      EXPORTED: "exported",
      DOUBLE: "a b\nc",
      SINGLE: "literal\\n",
      SPACED: "spaced",
    });
  });
});

describe("createSecretsResolver", () => {
  it("prefers the environment over the secrets file", () => {
    const resolver = createSecretsResolver({
      environment: { A: "from-env" },
      secretsFileContents: "A=from-file\nB=from-file",
    });

    expect(resolver.resolve("A")).toBe("from-env");
    expect(resolver.resolve("B")).toBe("from-file");
    expect(resolver.resolve("MISSING")).toBeUndefined();
  });

  it("resolves from the file alone when no environment is given", () => {
    const resolver = createSecretsResolver({ secretsFileContents: "ONLY=file-value" });

    expect(resolver.resolve("ONLY")).toBe("file-value");
    expect(resolver.resolve("MISSING")).toBeUndefined();
  });
});

// --- discovery -------------------------------------------------------------

describe("discoverSources", () => {
  it("classifies a valid bundle as ok with capabilities and origin", () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });

    const [entry] = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: path.join(root, "task-sources"),
    });

    expect(entry).toMatchObject({
      status: "ok",
      name: "alpha",
      origin: "user",
      readOnly: false,
      capabilities: { list: true, get: true, update: true },
    });
  });

  it("defaults the source name to the directory name when the manifest omits it", () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "named-by-dir", manifest: defaultManifest({ withUpdate: true }) });

    const entry = discoverOk({ root, name: "named-by-dir" });

    expect(entry.name).toBe("named-by-dir");
  });

  it("marks a source without update as read-only", () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "ro", withUpdate: false });

    const entry = discoverOk({ root, name: "ro" });

    expect(entry.readOnly).toBe(true);
    expect(entry.capabilities.update).toBe(false);
  });

  it("returns an unsupported entry naming the version and supported set, not a silent drop", () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "future", manifest: { protocolVersion: 99, commands: { list: "./list" } } });

    const [entry] = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: path.join(root, "task-sources"),
    });

    expect(entry?.status).toBe("unsupported");
    expect(entry).toMatchObject({ status: "unsupported", message: expect.stringMatching(/99/) });
    expect(entry).toMatchObject({ status: "unsupported", message: expect.stringMatching(/\b1\b/) });
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([1]);
  });

  it("returns an invalid entry (skip + warn) for an unparseable manifest, naming source.json", () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "broken", badManifestJson: "{ not json,,, \n" });

    const [entry] = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: path.join(root, "task-sources"),
    });

    expect(entry?.status).toBe("invalid");
    expect(entry).toMatchObject({ status: "invalid", warning: expect.stringMatching(/source\.json/) });
    expect(entry?.name).toBe("broken");
  });

  it("lets a user bundle shadow a same-named package bundle, representing the override", () => {
    const root = temporaryRoot();
    writeBundle({ root, parent: "package", name: "dup" });
    writeBundle({ root, parent: "task-sources", name: "dup" });

    const discovered = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: path.join(root, "task-sources"),
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ name: "dup", origin: "user", shadows: "package" });
  });

  it("scans both directories and sorts distinct names", () => {
    const root = temporaryRoot();
    writeBundle({ root, parent: "package", name: "zeta" });
    writeBundle({ root, parent: "task-sources", name: "alpha" });

    const discovered = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: path.join(root, "task-sources"),
    });

    expect(discovered.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("returns nothing when the directories do not exist", () => {
    const root = temporaryRoot();

    const discovered = discoverSources({
      packageBundlesDirectory: path.join(root, "nope-package"),
      userBundlesDirectory: path.join(root, "nope-user"),
    });

    expect(discovered).toEqual([]);
  });

  it("ignores non-directory entries and directories without a source.json", () => {
    const root = temporaryRoot();
    const sources = path.join(root, "task-sources");
    fs.mkdirSync(sources, { recursive: true });
    fs.writeFileSync(path.join(sources, "loose-file"), "not a bundle");
    fs.mkdirSync(path.join(sources, "empty-dir"), { recursive: true });
    writeBundle({ root, name: "real" });

    const discovered = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: sources,
    });

    expect(discovered.map((entry) => entry.name)).toEqual(["real"]);
  });

  it("returns an invalid entry when source.json cannot be read", () => {
    const root = temporaryRoot();
    const bundle = path.join(root, "task-sources", "unreadable");
    fs.mkdirSync(bundle, { recursive: true });
    // A directory in place of the file makes readFileSync throw EISDIR.
    fs.mkdirSync(path.join(bundle, "source.json"));

    const [entry] = discoverSources({
      packageBundlesDirectory: path.join(root, "package"),
      userBundlesDirectory: path.join(root, "task-sources"),
    });

    expect(entry?.status).toBe("invalid");
    expect(entry).toMatchObject({
      status: "invalid",
      warning: expect.stringMatching(/could not read source\.json/),
    });
  });
});

// --- openSource: live protocol ---------------------------------------------

function journalPath(root: string): string {
  return path.join(root, "journal.jsonl");
}

function readJournal(root: string): Array<Record<string, unknown>> {
  const file = journalPath(root);
  if (!fs.existsSync(file)) {
    return [];
  }

  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function baseConfig(root: string, extra?: Record<string, string>): SourceConfig {
  return {
    environment: { PROTOCOL_JOURNAL: journalPath(root), ...extra },
  };
}

describe("openSource — live protocol", () => {
  it("lists tasks across a real spawn", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, { TASKS: JSON.stringify([{ id: "T1", title: "One" }]) }),
    });

    const tasks = await handle.list();

    expect(tasks).toEqual([{ id: "T1", title: "One" }]);
  });

  it("gets a task by id", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, {
        TASKS: JSON.stringify([{ id: "T1", title: "One" }, { id: "T2", title: "Two" }]),
      }),
    });

    const task = await handle.get("T2");

    expect(task).toEqual({ id: "T2", title: "Two" });
  });

  it("distinguishes an ok claim from a rejected one", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, { REJECT: "T9" }),
    });
    const claimed: WritebackEvent = { type: "claimed", runId: "r_1" };

    expect(await handle.update("T1", claimed)).toEqual({ result: "ok" });
    expect(await handle.update("T9", claimed)).toEqual({ result: "rejected", reason: "contended" });
  });

  it("pre-creates the scratch dir and passes it as GROUNDCREW_SOURCE_SCRATCH", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const stateRoot = path.join(root, "state");
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot,
      sourceConfig: baseConfig(root),
    });
    const expectedScratch = path.join(stateRoot, "source-scratch", "alpha");

    await handle.list();

    expect(fs.existsSync(expectedScratch)).toBe(true);
    const scratch = readJournal(root)[0]?.["scratch"];
    expect(scratch).toBe(expectedScratch + path.sep);
  });

  it("composes env: config overrides manifest, secrets resolve, parent env does not leak", async () => {
    const root = temporaryRoot();
    writeBundle({
      root,
      name: "alpha",
      manifest: {
        protocolVersion: 1,
        commands: { list: "./list", get: "./get", update: "./update" },
        environment: { OVERRIDE_ME: "manifest", FROM_MANIFEST: "m" },
        secrets: ["MY_SECRET"],
      },
    });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, { OVERRIDE_ME: "config" }),
      parentEnvironment: {
        PATH: REAL_PATH,
        HOME: REAL_HOME,
        MY_SECRET: "sekret",
        PARENT_LEAK: "should-not-appear",
      },
    });

    await handle.list();

    expect(handle.missingSecrets).toEqual([]);
    const seen = readJournal(root)[0]?.["env"] as Record<string, unknown>;
    expect(seen).toMatchObject({
      OVERRIDE_ME: "config",
      FROM_MANIFEST: "m",
      MY_SECRET: "sekret",
      HAS_PATH: true,
    });
    expect(seen["PARENT_LEAK"]).toBeUndefined();
  });

  it("logs source stderr to the acquisition module and never to stdout parsing", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const logged: Array<Record<string, unknown>> = [];
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, { LIST_STDERR: "1" }),
      logger: {
        log: (entry) => {
          logged.push(entry as unknown as Record<string, unknown>);
        },
      },
    });

    const tasks = await handle.list();

    expect(tasks).toEqual([]); // stderr did not corrupt stdout parsing
    expect(logged).toContainEqual(
      expect.objectContaining({ module: "acquisition", event: "source_stderr", source: "alpha" }),
    );
  });

  it("records a missing declared secret without crashing at spawn", async () => {
    const root = temporaryRoot();
    writeBundle({
      root,
      name: "alpha",
      manifest: {
        protocolVersion: 1,
        commands: { list: "./list" },
        secrets: ["ABSENT_SECRET"],
      },
    });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root),
      parentEnvironment: { PATH: REAL_PATH, HOME: REAL_HOME },
    });

    expect(handle.missingSecrets).toEqual(["ABSENT_SECRET"]);
    await expect(handle.list()).resolves.toEqual([]); // still runs, no crash
  });

  it("no-ops update on a read-only source with zero spawns", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "ro", withUpdate: false });
    const handle = openSource({
      discovered: discoverOk({ root, name: "ro" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root),
    });

    expect(handle.readOnly).toBe(true);
    const result = await handle.update("T1", { type: "completed", outcome: "delivered" });

    expect(result).toEqual({ result: "ok" });
    expect(readJournal(root).filter((entry) => entry["command"] === "update")).toHaveLength(0);
  });

  it("throws when asked to get from a source with no get command", async () => {
    const root = temporaryRoot();
    writeBundle({
      root,
      name: "listonly",
      manifest: { protocolVersion: 1, commands: { list: "./list" } },
    });
    const handle = openSource({
      discovered: discoverOk({ root, name: "listonly" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root),
    });

    await expect(handle.get("T1")).rejects.toBeInstanceOf(SourceProtocolError);
  });

  it("throws for a non-ok discovered source", () => {
    const root = temporaryRoot();
    const invalid: DiscoveredSource = {
      status: "invalid",
      name: "x",
      origin: "user",
      bundleDirectory: root,
      warning: "bad",
    };

    expect(() =>
      openSource({ discovered: invalid, stateRoot: path.join(root, "state") }),
    ).toThrow(/requires a supported source/);
  });
});

// --- openSource: failure mappings ------------------------------------------

async function expectListFailure(input: {
  readonly root: string;
  readonly name: string;
  readonly config: Record<string, string>;
  readonly kind: SourceProtocolError["kind"];
  readonly timeoutMilliseconds?: number;
}): Promise<void> {
  const handle = openSource({
    discovered: discoverOk({ root: input.root, name: input.name }),
    stateRoot: path.join(input.root, "state"),
    sourceConfig: baseConfig(input.root, input.config),
    ...(input.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: input.timeoutMilliseconds }),
  });

  await handle.list().then(
    () => {
      throw new Error("expected list to reject");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(SourceProtocolError);
      expect((error as SourceProtocolError).kind).toBe(input.kind);
      expect((error as SourceProtocolError).source).toBe(input.name);
    },
  );
}

describe("openSource — failure mappings (all → SourceProtocolError)", () => {
  it("maps a source-emitted { ok: false } to protocol-failure", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    await expectListFailure({ root, name: "alpha", config: { LIST_FAIL: "1" }, kind: "protocol-failure" });
  });

  it("maps a nonzero exit to nonzero-exit", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    await expectListFailure({ root, name: "alpha", config: { LIST_EXIT: "2" }, kind: "nonzero-exit" });
  });

  it("maps unparseable stdout to unparseable-stdout", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    await expectListFailure({ root, name: "alpha", config: { LIST_GARBAGE: "1" }, kind: "unparseable-stdout" });
  });

  it("maps a timeout to timeout", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    await expectListFailure({
      root,
      name: "alpha",
      config: { LIST_SLEEP: "5000" },
      kind: "timeout",
      timeoutMilliseconds: 250,
    });
  });

  it("maps a missing executable to spawn-failure", async () => {
    const root = temporaryRoot();
    writeBundle({
      root,
      name: "ghost",
      manifest: { protocolVersion: 1, commands: { list: "./does-not-exist" } },
    });
    await expectListFailure({ root, name: "ghost", config: {}, kind: "spawn-failure" });
  });

  it("maps valid JSON that is not result-shaped to unparseable-stdout", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    await expectListFailure({ root, name: "alpha", config: { LIST_BADENVELOPE: "1" }, kind: "unparseable-stdout" });
  });

  it("maps well-formed success data of the wrong shape to unparseable-stdout", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    await expectListFailure({ root, name: "alpha", config: { LIST_BADSHAPE: "1" }, kind: "unparseable-stdout" });
  });
});

// --- sandbox wrap seam -----------------------------------------------------

describe("openSource — sandbox wrap seam", () => {
  it("wraps the command with the bundle read-only, scratch writable, manifest network", async () => {
    const root = temporaryRoot();
    const bundleDirectory = writeBundle({
      root,
      name: "alpha",
      manifest: {
        protocolVersion: 1,
        commands: { list: "./list", get: "./get", update: "./update" },
        network: ["api.example.com"],
      },
    });
    const stateRoot = path.join(root, "state");
    const calls: Array<{ command: string; policy: unknown }> = [];
    const wrapCommand: WrapCommand = async (wrapInput) => {
      calls.push({ command: wrapInput.command, policy: wrapInput.policy });
      return { command: wrapInput.command }; // run the script as-is under shell
    };
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot,
      sourceConfig: baseConfig(root),
      wrapCommand,
    });

    await handle.list();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy).toEqual({
      readOnlyPaths: [bundleDirectory],
      writablePaths: [path.join(stateRoot, "source-scratch", "alpha")],
      network: ["api.example.com"],
    });
  });

  it("skips the wrap and flags the opt-out when sandbox is false", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const calls: string[] = [];
    const wrapCommand: WrapCommand = async (wrapInput) => {
      calls.push(wrapInput.command);
      return { command: wrapInput.command };
    };
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: { ...baseConfig(root), sandbox: false },
      wrapCommand,
    });

    await handle.list();

    expect(handle.sandboxOptOut).toBe(true);
    expect(calls).toEqual([]);
  });
});

// --- probe / missingSecretError --------------------------------------------

describe("probeSource", () => {
  it("reports ok with a task count on a live round-trip", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, { TASKS: JSON.stringify([{ id: "T1", title: "One" }]) }),
    });

    expect(await probeSource({ handle })).toEqual({ ok: true, source: "alpha", taskCount: 1 });
  });

  it("reports failure naming the source when list fails", async () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root, { LIST_FAIL: "1" }),
    });

    const actual = await probeSource({ handle });

    expect(actual.ok).toBe(false);
    expect(actual.source).toBe("alpha");
  });

  it("reports a missing secret as a failure before spawning", async () => {
    const root = temporaryRoot();
    writeBundle({
      root,
      name: "alpha",
      manifest: { protocolVersion: 1, commands: { list: "./list" }, secrets: ["ABSENT"] },
    });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root),
      parentEnvironment: { PATH: REAL_PATH, HOME: REAL_HOME },
    });

    const actual = await probeSource({ handle });

    expect(actual).toEqual({ ok: false, source: "alpha", message: expect.stringMatching(/ABSENT/) });
    expect(readJournal(root)).toHaveLength(0); // did not spawn
  });
});

describe("missingSecretError", () => {
  it("builds a typed error for a handle with missing secrets", () => {
    const root = temporaryRoot();
    writeBundle({
      root,
      name: "alpha",
      manifest: { protocolVersion: 1, commands: { list: "./list" }, secrets: ["ABSENT"] },
    });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root),
      parentEnvironment: { PATH: REAL_PATH, HOME: REAL_HOME },
    });

    const actual = missingSecretError(handle);

    expect(actual).toBeInstanceOf(MissingSecretError);
    expect(actual?.secretNames).toEqual(["ABSENT"]);
  });

  it("returns undefined when nothing is missing", () => {
    const root = temporaryRoot();
    writeBundle({ root, name: "alpha" });
    const handle = openSource({
      discovered: discoverOk({ root, name: "alpha" }),
      stateRoot: path.join(root, "state"),
      sourceConfig: baseConfig(root),
    });

    expect(missingSecretError(handle)).toBeUndefined();
  });
});
