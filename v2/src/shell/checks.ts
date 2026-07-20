/**
 * Doctor checks (design §7.1, contracts §7): a check is a named pass/fail with a
 * cause on failure, so `crew doctor` and `crew source doctor` both name what is
 * wrong. The per-source subset (manifest → protocol → prerequisites → secrets →
 * live round-trip) is shared between the two commands (SURFACE-02, SURFACE-07).
 */
import * as fs from "node:fs";
import process from "node:process";

import { type ProbeResult, probeSource } from "../acquisition/index.js";
import { describeSandboxRunner } from "../sandbox/index.js";
import { isPresetName, resolveProfile } from "../session/index.js";
import type { Context, ResolvedSource } from "./context.js";
import { onPath } from "./detect.js";

/** One doctor finding. */
export interface CheckResult {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string | undefined;
  /** The source a per-source check belongs to (SURFACE-07 naming). */
  readonly source: string | undefined;
  /**
   * An informational note rather than a pass/fail: rendered distinctly and never
   * failing the run (e.g. unrecognized v1 state files in the runs dir).
   */
  readonly note?: boolean;
}

function pass(label: string, detail?: string): CheckResult {
  return { label, ok: true, detail, source: undefined };
}

function fail(label: string, detail: string): CheckResult {
  return { label, ok: false, detail, source: undefined };
}

/** Required host tools: git, the presenter binary, and the srt sandbox runner. */
export async function checkRequiredTools(context: Context): Promise<CheckResult[]> {
  const pathValue = context.environment.PATH ?? "";
  const results: CheckResult[] = [
    onPath({ name: "git", pathValue })
      ? pass("git on PATH")
      : fail("git on PATH", "git was not found on PATH"),
  ];

  const presenter = context.config.presenter;
  if (presenter === undefined) {
    const found = ["cmux", "tmux", "zellij"].find((name) => onPath({ name, pathValue }));
    results.push(
      found === undefined
        ? fail("a session presenter on PATH", "none of cmux, tmux, zellij were found on PATH")
        : pass(`session presenter "${found}" on PATH`),
    );
  } else {
    results.push(
      onPath({ name: presenter, pathValue })
        ? pass(`presenter "${presenter}" on PATH`)
        : fail(`presenter "${presenter}" on PATH`, `${presenter} was not found on PATH`),
    );
  }

  const runner = await describeSandboxRunner();
  results.push(
    runner.available
      ? pass("srt sandbox runner available")
      : fail("srt sandbox runner available", runner.detail ?? "the srt runner is not usable on this host"),
  );

  return results;
}

/**
 * Warns (never fails) when the optional `secrets.env` exists and is readable or
 * writable by group/other (contracts §2: doctor warns unless mode 0600). A
 * world-readable secrets file leaks the tokens sources authenticate with. On a
 * host with no POSIX permission bits (Windows) the mode is not meaningful, so
 * the check is skipped there. Returns `undefined` when there is nothing to warn
 * about, so doctor emits the note only when it applies.
 */
export function checkSecretsFilePermissions(
  secretsPath: string,
  platform: NodeJS.Platform = process.platform,
): CheckResult | undefined {
  if (platform === "win32") {
    return undefined;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(secretsPath);
  } catch {
    return undefined; // no secrets.env — nothing to warn about
  }
  if (!stat.isFile()) {
    return undefined;
  }

  // `mode % 0o100` is the low 6 bits (group+other rwx) without a bitwise op;
  // nonzero ⇒ group/other has some access. `mode % 0o1000` is the 9-bit perm set.
  const groupOtherBits = stat.mode % 0o100;
  if (groupOtherBits === 0) {
    return undefined; // 0600 or tighter — the desired posture
  }

  const mode = (stat.mode % 0o1000).toString(8).padStart(3, "0");
  return {
    label:
      `secrets.env is group/other-accessible (mode ${mode}) at ${secretsPath}; ` +
      `run \`chmod 600 ${secretsPath}\` so only you can read it`,
    ok: true,
    detail: undefined,
    source: undefined,
    note: true,
  };
}

/** The configured `workspace.baseDirectory` exists and is a directory (SURFACE-02c). */
export function checkBaseDirectory(context: Context): CheckResult {
  const directory = context.workspaceConfig().baseDirectory;
  try {
    if (fs.statSync(directory).isDirectory()) {
      return pass(`base directory ${directory}`);
    }
  } catch {
    // Falls through to the failure below.
  }

  return fail(
    "workspace.baseDirectory exists",
    `workspace.baseDirectory ${directory} is not a directory on disk`,
  );
}

/** Agent profiles referenced by config resolve, and their commands are on PATH. */
export function checkAgents(context: Context): CheckResult[] {
  const profiles = context.config.agents?.profiles ?? {};
  const pathValue = context.environment.PATH ?? "";
  const results: CheckResult[] = [];

  for (const name of Object.keys(profiles)) {
    try {
      const resolved = resolveProfile({ name, profile: context.agentProfile(name) });
      const executable = firstToken(resolved.commandTemplate);
      const runnable = executable === undefined || onPath({ name: executable, pathValue });
      results.push(
        runnable
          ? pass(`agent profile "${name}" resolves`)
          : fail(`agent profile "${name}" command on PATH`, `"${executable}" was not found on PATH`),
      );
    } catch (error) {
      results.push(fail(`agent profile "${name}" resolves`, messageOf(error)));
    }
  }

  const defaultName = context.config.agents?.default;
  if (defaultName !== undefined && profiles[defaultName] === undefined && !isPresetName(defaultName)) {
    results.push(
      fail("default agent profile exists", `agents.default "${defaultName}" is not a defined profile`),
    );
  }

  return results;
}

/** Flags credential-looking strings in the config file (design §7.2 principle 2). */
export function checkCredentialsInConfig(rawConfigText: string): CheckResult {
  const suspicious = findCredentialLikeStrings(rawConfigText);
  return suspicious.length === 0
    ? pass("no credential-looking strings in config")
    : fail(
        "no credential-looking strings in config",
        `config contains values that look like secrets: ${suspicious.join(", ")}. ` +
          "Secrets are resolved from the environment or secrets.env by NAME, never stored in config.",
      );
}

/**
 * The per-source deep check (SURFACE-02/07): discovery status, protocol support,
 * prerequisites on PATH, declared secrets resolvable, then a live `list`
 * round-trip. Returns findings all tagged with the source name.
 */
export async function checkSource(input: {
  readonly context: Context;
  readonly resolved: ResolvedSource;
}): Promise<CheckResult[]> {
  const { context, resolved } = input;
  const name = resolved.name;
  const tag = (result: CheckResult): CheckResult => ({ ...result, source: name });
  const discovered = resolved.discovered;

  if (discovered === undefined) {
    return [tag(fail(`source "${name}" discovered`, `no bundle named "${resolved.entry.kind}" found`))];
  }

  if (discovered.status === "invalid") {
    return [tag(fail(`source "${name}" manifest parses`, discovered.warning))];
  }

  if (discovered.status === "unsupported") {
    return [
      tag(
        fail(
          `source "${name}" protocol supported`,
          `protocol ${String(discovered.protocolVersion)} is unsupported ` +
            `(supported: ${discovered.supportedVersions.join(", ")})`,
        ),
      ),
    ];
  }

  const results: CheckResult[] = [tag(pass(`source "${name}" manifest and protocol ok`))];
  const pathValue = context.environment.PATH ?? "";
  for (const prerequisite of discovered.manifest.prerequisites) {
    results.push(
      tag(
        onPath({ name: prerequisite, pathValue })
          ? pass(`source "${name}" prerequisite "${prerequisite}"`)
          : fail(`source "${name}" prerequisite "${prerequisite}"`, `"${prerequisite}" not on PATH`),
      ),
    );
  }

  const handle = context.openHandle(resolved);
  if (handle === undefined) {
    results.push(tag(fail(`source "${name}" opens`, "the source bundle could not be opened")));
    return results;
  }

  if (handle.missingSecrets.length > 0) {
    results.push(
      tag(
        fail(
          `source "${name}" secrets resolvable`,
          `missing declared secret(s): ${handle.missingSecrets.join(", ")}`,
        ),
      ),
    );
  }

  const probe: ProbeResult = await probeSource({ handle });
  results.push(
    tag(
      probe.ok
        ? pass(`source "${name}" live list round-trip (${String(probe.taskCount)} task(s))`)
        : fail(`source "${name}" live list round-trip`, probe.message),
    ),
  );

  return results;
}

function firstToken(command: string): string | undefined {
  return command.trim().split(/\s+/u)[0];
}

const CREDENTIAL_KEY = /(secret|token|api[_-]?key|password|passwd|bearer)/iu;
const CREDENTIAL_VALUE = /^(sk-|ghp_|github_pat_|xox[baprs]-|AKIA|eyJ[A-Za-z0-9_-]{10,})/u;

function findCredentialLikeStrings(rawConfigText: string): string[] {
  const found = new Set<string>();
  const pairPattern = /"([^"]+)"\s*:\s*"([^"]*)"/gu;
  for (const match of rawConfigText.matchAll(pairPattern)) {
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (value.length >= 20 && (CREDENTIAL_KEY.test(key) || CREDENTIAL_VALUE.test(value))) {
      found.add(key);
    }
  }

  return [...found];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
