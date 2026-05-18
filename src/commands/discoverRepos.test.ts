import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, resolveConfigPath, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "../testHelpers/consoleCapture.ts";
import { discoverRepos, discoverReposCli } from "./discoverRepos.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shared sync/async mock recorder for test only.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, which: vi.fn<typeof actual.which>() };
});
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: vi.fn<typeof loadConfig>(),
    resolveConfigPath: vi.fn<typeof resolveConfigPath>(),
  };
});

const whichMock = vi.mocked(which);
const loadConfigMock = vi.mocked(loadConfig);
const resolveConfigPathMock = vi.mocked(resolveConfigPath);

const CONFIG_TEMPLATE = [
  "export const config = {",
  "  workspace: {",
  "    projectDir: '/tmp/groundcrew-workspaces',",
  "    knownRepositories: [",
  '      "owner/existing", // first entry',
  "    ],",
  "  },",
  "};",
  "",
].join("\n");

function makeConfig(overrides: { knownRepositories: string[] }): ResolvedConfig {
  return {
    linear: {
      projectSlug: "x-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
    },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/tmp/groundcrew-workspaces",
      knownRepositories: overrides.knownRepositories,
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    logging: { file: "/tmp/groundcrew-test.log" },
    remote: {
      provider: "sprite",
      runnerName: "crew-claude-1",
      owner: "ClipboardHealth",
      repoRoot: "/home/sprite/dev",
      worktreeRoot: "/home/sprite/groundcrew/worktrees",
      secretNames: ["NPM_TOKEN", "BUF_TOKEN"],
    },
  };
}

const GH_FOUR_REPOS = JSON.stringify([
  { name: "active", isArchived: false, isFork: false, isDisabled: false },
  { name: "old", isArchived: true, isFork: false, isDisabled: false },
  { name: "mirror", isArchived: false, isFork: true, isDisabled: false },
  { name: "broken", isArchived: false, isFork: false, isDisabled: true },
]);

let dir: string;
let configPath: string;

describe(discoverRepos, () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "groundcrew-discover-repos-"));
    configPath = join(dir, "config.ts");
    writeFileSync(configPath, CONFIG_TEMPLATE);
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    whichMock.mockResolvedValue("/usr/local/bin/gh");
    runCommandMock.mockReturnValue(GH_FOUR_REPOS);
    resolveConfigPathMock.mockReturnValue(configPath);
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    rmSync(dir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("adds only active repos and filters archived/fork/disabled with reasons", async () => {
    const config = makeConfig({ knownRepositories: ["owner/existing"] });

    const result = await discoverRepos(config, "myorg", {});

    expect(result.added).toStrictEqual(["myorg/active"]);
    expect(result.alreadyKnown).toStrictEqual([]);
    expect(result.filtered.map((f) => f.repo)).toStrictEqual([
      "myorg/old",
      "myorg/mirror",
      "myorg/broken",
    ]);
    const [archived, fork, disabled] = result.filtered;
    expect(archived?.reasons).toContain("archived");
    expect(fork?.reasons).toContain("fork");
    expect(disabled?.reasons).toContain("disabled");
    expect(readFileSync(configPath, "utf8")).toContain('"myorg/active",');
    expect(readFileSync(configPath, "utf8")).toContain("// first entry");
  });

  it("invokes gh with the documented flags and --json projection", async () => {
    const config = makeConfig({ knownRepositories: [] });

    await discoverRepos(config, "myorg", {});

    expect(runCommandMock).toHaveBeenCalledWith("gh", [
      "repo",
      "list",
      "myorg",
      "--no-archived",
      "--source",
      "--limit",
      "1000",
      "--json",
      "name,isArchived,isFork,isDisabled",
    ]);
  });

  it("is a no-op when every active repo is already in knownRepositories", async () => {
    const original = readFileSync(configPath);
    const originalMtime = statSync(configPath).mtimeMs;
    const config = makeConfig({ knownRepositories: ["owner/existing", "myorg/active"] });

    const result = await discoverRepos(config, "myorg", {});

    expect(result.added).toStrictEqual([]);
    expect(result.alreadyKnown).toStrictEqual(["myorg/active"]);
    expect(readFileSync(configPath)).toStrictEqual(original);
    expect(statSync(configPath).mtimeMs).toBe(originalMtime);
  });

  it("does not write config.ts in --dry-run mode but reports the would-be diff", async () => {
    const original = readFileSync(configPath, "utf8");
    const config = makeConfig({ knownRepositories: ["owner/existing", "myorg/old"] });

    const result = await discoverRepos(config, "myorg", { dryRun: true });

    expect(result.added).toStrictEqual(["myorg/active"]);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(consoleLog.output()).toContain("dry-run");
    expect(consoleLog.output()).toContain("+ myorg/active");
  });

  it("marks already-known repos with a space (not `+`) in the dry-run diff", async () => {
    runCommandMock.mockReturnValue(
      JSON.stringify([
        { name: "active", isArchived: false, isFork: false, isDisabled: false },
        { name: "known", isArchived: false, isFork: false, isDisabled: false },
      ]),
    );
    const config = makeConfig({ knownRepositories: ["myorg/known"] });

    await discoverRepos(config, "myorg", { dryRun: true });

    expect(consoleLog.output()).toContain("+ myorg/active");
    expect(consoleLog.output()).toContain("  myorg/known");
  });

  it("reports gh missing without calling runCommand or touching config.ts", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- which returns Promise<string | undefined>; passing nothing is a TS error
    whichMock.mockResolvedValue(undefined);
    const original = readFileSync(configPath, "utf8");
    const config = makeConfig({ knownRepositories: ["owner/existing"] });

    const result = await discoverRepos(config, "myorg", {});

    expect(result.ghMissing).toBe(true);
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(consoleError.output()).toContain("cli.github.com");
    expect(consoleError.output()).not.toContain("brew install");
  });

  it("surfaces errors from gh repo list and leaves config.ts untouched", async () => {
    runCommandMock.mockImplementation(() => {
      throw new Error("gh: HTTP 401");
    });
    const original = readFileSync(configPath, "utf8");
    const config = makeConfig({ knownRepositories: ["owner/existing"] });

    await expect(discoverRepos(config, "myorg", {})).rejects.toThrow(/HTTP 401/);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("preserves the inline comment on an existing entry after writeback", async () => {
    const config = makeConfig({ knownRepositories: ["owner/existing"] });

    await discoverRepos(config, "myorg", {});

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain('"owner/existing", // first entry');
    expect(after).toContain('"myorg/active",');
  });

  it("drops gh entries that are null or have missing/wrong-typed fields", async () => {
    runCommandMock.mockReturnValue(
      JSON.stringify([
        null,
        "string-entry",
        { name: 42, isArchived: false, isFork: false, isDisabled: false },
        { isArchived: false, isFork: false, isDisabled: false },
        { name: "noArchived", isFork: false, isDisabled: false },
        { name: "badFork", isArchived: false, isFork: "no", isDisabled: false },
        { name: "badDisabled", isArchived: false, isFork: false, isDisabled: 0 },
        { name: "good", isArchived: false, isFork: false, isDisabled: false },
      ]),
    );
    const config = makeConfig({ knownRepositories: [] });

    const result = await discoverRepos(config, "myorg", { dryRun: true });

    expect(result.added).toStrictEqual(["myorg/good"]);
  });

  it("throws with a clear message when gh stdout is not JSON", async () => {
    runCommandMock.mockReturnValue("not-json");
    const config = makeConfig({ knownRepositories: [] });

    await expect(discoverRepos(config, "myorg", {})).rejects.toThrow(/non-JSON output/);
  });

  it("throws when gh stdout is JSON but not an array", async () => {
    runCommandMock.mockReturnValue('{"total":3}');
    const config = makeConfig({ knownRepositories: [] });

    await expect(discoverRepos(config, "myorg", {})).rejects.toThrow(/did not return an array/);
  });

  it("warns to stderr when gh returns exactly the page-size limit", async () => {
    const PAGE = 1000;
    const entries = Array.from({ length: PAGE }, (_, i) => ({
      name: `repo-${i}`,
      isArchived: false,
      isFork: false,
      isDisabled: false,
    }));
    runCommandMock.mockReturnValue(JSON.stringify(entries));
    const config = makeConfig({ knownRepositories: [] });

    await discoverRepos(config, "myorg", { dryRun: true });

    expect(consoleError.output()).toContain("warning");
    expect(consoleError.output()).toContain("1000");
    expect(consoleError.output()).toContain("myorg");
  });
});

describe(discoverReposCli, () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "groundcrew-discover-cli-"));
    configPath = join(dir, "config.ts");
    writeFileSync(configPath, CONFIG_TEMPLATE);
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    whichMock.mockResolvedValue("/usr/local/bin/gh");
    runCommandMock.mockReturnValue("[]");
    loadConfigMock.mockResolvedValue(makeConfig({ knownRepositories: ["owner/existing"] }));
    resolveConfigPathMock.mockReturnValue(configPath);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.resetAllMocks();
  });

  it("requires a positional <org>", async () => {
    await expect(discoverReposCli([])).rejects.toThrow(/<org> is required/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("rejects an empty-string <org>", async () => {
    await expect(discoverReposCli([""])).rejects.toThrow(/<org> is required/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("rejects unknown flags instead of treating them as the org name", async () => {
    await expect(discoverReposCli(["--bogus", "myorg"])).rejects.toThrow(/Unknown option: --bogus/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("rejects extra positional args after <org>", async () => {
    await expect(discoverReposCli(["myorg", "extra"])).rejects.toThrow(/Too many positional/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("dispatches discoverRepos with the parsed positional org", async () => {
    runCommandMock.mockReturnValue(GH_FOUR_REPOS);

    await discoverReposCli(["myorg"]);

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["repo", "list", "myorg"]),
    );
  });

  it("forwards --dry-run without writing the config", async () => {
    runCommandMock.mockReturnValue(GH_FOUR_REPOS);
    const original = readFileSync(configPath, "utf8");

    await discoverReposCli(["--dry-run", "myorg"]);

    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(consoleLog.output()).toContain("dry-run");
  });

  it("sets process.exitCode = 1 when gh is missing", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- which returns Promise<string | undefined>; passing nothing is a TS error
    whichMock.mockResolvedValue(undefined);

    await discoverReposCli(["myorg"]);

    expect(process.exitCode).toBe(1);
  });

  it("leaves process.exitCode unset on a successful no-op", async () => {
    runCommandMock.mockReturnValue("[]");

    await discoverReposCli(["myorg"]);

    expect(process.exitCode).toBeUndefined();
  });
});
