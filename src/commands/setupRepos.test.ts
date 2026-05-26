import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { setupRepos, setupReposCli } from "./setupRepos.ts";

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, which: vi.fn<typeof actual.which>() };
});
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});

const whichMock = vi.mocked(which);
const loadConfigMock = vi.mocked(loadConfig);

function makeConfig(overrides: {
  projectDir: string;
  knownRepositories: string[];
}): ResolvedConfig {
  return {
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: overrides.projectDir,
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
    local: { runner: "auto" },
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

let projectDir: string;

function makeGitRepositoryTarget(...segments: string[]): string {
  const target = join(projectDir, ...segments);
  mkdirSync(join(target, ".git"), { recursive: true });
  return target;
}

describe(setupRepos, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "groundcrew-setup-repos-"));
    consoleLog = captureConsoleLog();
    whichMock.mockResolvedValue("/usr/local/bin/gh");
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(projectDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("clones a missing repo via `gh repo clone <entry> <target>`", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/repo", join(projectDir, "owner/repo")],
      expect.anything(),
    );
    expect(result.cloned).toStrictEqual(["owner/repo"]);
    expect(result.existing).toStrictEqual([]);
    expect(result.failed).toStrictEqual([]);
  });

  it("creates the owner parent directory before cloning into an owner/repo target", async () => {
    runCommandMock.mockImplementationOnce((_command, arguments_) => {
      const { 3: target = "" } = arguments_;
      expect(target).toBe(join(projectDir, "owner/repo"));
      expect(existsSync(dirname(target))).toBe(true);
      return "";
    });
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(result.cloned).toStrictEqual(["owner/repo"]);
    expect(result.failed).toStrictEqual([]);
  });

  it("skips a repo whose target is already a git repository", async () => {
    makeGitRepositoryTarget("owner", "repo");
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.existing).toStrictEqual(["owner/repo"]);
    expect(result.cloned).toStrictEqual([]);
  });

  it("clones into an existing empty target directory", async () => {
    mkdirSync(join(projectDir, "owner", "repo"), { recursive: true });
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/repo", join(projectDir, "owner/repo")],
      expect.anything(),
    );
    expect(result.cloned).toStrictEqual(["owner/repo"]);
    expect(result.existing).toStrictEqual([]);
  });

  it("skips a non-git directory target instead of reporting it as existing", async () => {
    mkdirSync(join(projectDir, "owner", "repo"), { recursive: true });
    writeFileSync(join(projectDir, "owner", "repo", "README.md"), "not a clone");
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.existing).toStrictEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.repo).toBe("owner/repo");
    expect(result.skipped[0]?.kind).toBe("invalid-target");
    expect(result.skipped[0]?.reason).toContain("not a git repository");
  });

  it("skips a file target instead of reporting it as existing", async () => {
    mkdirSync(join(projectDir, "owner"), { recursive: true });
    writeFileSync(join(projectDir, "owner", "repo"), "not a directory");
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.repo).toBe("owner/repo");
    expect(result.skipped[0]?.kind).toBe("invalid-target");
  });

  it("clones only the missing entries when some already exist", async () => {
    makeGitRepositoryTarget("owner", "have");
    const config = makeConfig({
      projectDir,
      knownRepositories: ["owner/have", "owner/missing"],
    });

    const result = await setupRepos(config, {});

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/missing", join(projectDir, "owner/missing")],
      expect.anything(),
    );
    expect(result.existing).toStrictEqual(["owner/have"]);
    expect(result.cloned).toStrictEqual(["owner/missing"]);
  });

  it("does not invoke gh in dry-run mode and reports what would be cloned", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, { dryRun: true });

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.cloned).toStrictEqual([]);
    expect(result.planned).toStrictEqual(["owner/repo"]);
    expect(consoleLog.output()).toContain("[dry-run]");
    expect(consoleLog.output()).toContain("owner/repo");
  });

  it("filters cloning to the `only` subset when provided", async () => {
    const config = makeConfig({
      projectDir,
      knownRepositories: ["owner/a", "owner/b"],
    });

    const result = await setupRepos(config, { only: ["owner/b"] });

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/b", join(projectDir, "owner/b")],
      expect.anything(),
    );
    expect(result.cloned).toStrictEqual(["owner/b"]);
  });

  it("deduplicates entries so a single repo is cloned at most once", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, { only: ["owner/repo", "owner/repo"] });

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(result.cloned).toStrictEqual(["owner/repo"]);
    expect(result.failed).toStrictEqual([]);
  });

  it("throws when `only` contains an entry not in knownRepositories", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["owner/a"] });

    await expect(setupRepos(config, { only: ["owner/missing"] })).rejects.toThrow(
      /not in workspace\.knownRepositories.*owner\/missing/,
    );
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("skips bare-name entries with a warning and marks the result skipped", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo", "bare"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/repo", join(projectDir, "owner/repo")],
      expect.anything(),
    );
    expect(result.cloned).toStrictEqual(["owner/repo"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.repo).toBe("bare");
    expect(result.skipped[0]?.kind).toBe("bare-name");
    expect(result.skipped[0]?.reason).toContain("owner/");
    expect(consoleLog.output()).toContain("[skip] bare");
  });

  it("skips malformed owner/repo entries instead of passing them to gh", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo/extra"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.cloned).toStrictEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.repo).toBe("owner/repo/extra");
    expect(result.skipped[0]?.kind).toBe("invalid-repository");
    expect(result.skipped[0]?.reason).toContain("owner/repo");
  });

  it("skips repository entries whose target would escape projectDir", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["../outside"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.cloned).toStrictEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.repo).toBe("../outside");
    expect(result.skipped[0]?.kind).toBe("invalid-repository");
    expect(result.skipped[0]?.reason).toContain("outside workspace.projectDir");
  });

  it("fails fast with an install hint when gh is not on PATH", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- `which` returns Promise<string | undefined>; passing nothing is a TS error
    whichMock.mockResolvedValue(undefined);
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.ghMissing).toBe(true);
    expect(result.cloned).toStrictEqual([]);
    expect(result.skipped).toStrictEqual([]);
    expect(consoleLog.output()).toMatch(/gh.*not found.*cli\.github\.com/);
  });

  it("does not probe for gh when there is nothing to clone", async () => {
    makeGitRepositoryTarget("owner", "have");
    const config = makeConfig({ projectDir, knownRepositories: ["owner/have"] });

    await setupRepos(config, {});

    expect(whichMock).not.toHaveBeenCalled();
  });

  it("captures failures and continues with remaining repos", async () => {
    runCommandMock
      .mockImplementationOnce(() => {
        throw new Error("auth failed");
      })
      .mockReturnValueOnce("");
    const config = makeConfig({
      projectDir,
      knownRepositories: ["owner/broken", "owner/ok"],
    });

    const result = await setupRepos(config, {});

    expect(runCommandMock).toHaveBeenCalledTimes(2);
    expect(result.cloned).toStrictEqual(["owner/ok"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.repo).toBe("owner/broken");
    expect(result.failed[0]?.error.message).toMatch(/auth failed/);
  });

  it("wraps a non-Error throw from gh into an Error carrying the message", async () => {
    runCommandMock.mockImplementationOnce(() => {
      // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- intentionally throws a non-Error to exercise the catch branch
      throw "gh died spectacularly";
    });
    const config = makeConfig({ projectDir, knownRepositories: ["owner/repo"] });

    const result = await setupRepos(config, {});

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toBeInstanceOf(Error);
    expect(result.failed[0]?.error.message).toBe("gh died spectacularly");
  });
});

describe(setupReposCli, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "groundcrew-setup-repos-cli-"));
    consoleLog = captureConsoleLog();
    whichMock.mockResolvedValue("/usr/local/bin/gh");
    runCommandMock.mockReturnValue("");
    loadConfigMock.mockResolvedValue(makeConfig({ projectDir, knownRepositories: ["owner/repo"] }));
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(projectDir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.resetAllMocks();
  });

  it("clones every missing knownRepositories entry with no args", async () => {
    await setupReposCli([]);

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/repo", join(projectDir, "owner/repo")],
      expect.anything(),
    );
  });

  it("parses --dry-run", async () => {
    await setupReposCli(["--dry-run"]);

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("[dry-run]");
  });

  it("treats positional args as the `only` subset", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({ projectDir, knownRepositories: ["owner/a", "owner/b"] }),
    );

    await setupReposCli(["owner/b"]);

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/b", join(projectDir, "owner/b")],
      expect.anything(),
    );
  });

  it("rejects unknown options instead of treating them as repo names", async () => {
    await expect(setupReposCli(["--bogus"])).rejects.toThrow(/Unknown option: --bogus/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("sets process.exitCode = 1 when gh is missing", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- `which` returns Promise<string | undefined>; passing nothing is a TS error
    whichMock.mockResolvedValue(undefined);

    await setupReposCli([]);

    expect(process.exitCode).toBe(1);
  });

  it("sets process.exitCode = 1 when any clone fails", async () => {
    runCommandMock.mockImplementation(() => {
      throw new Error("permission denied");
    });

    await setupReposCli([]);

    expect(process.exitCode).toBe(1);
  });

  it("sets process.exitCode = 1 when bare-name entries are skipped", async () => {
    makeGitRepositoryTarget("owner", "repo");
    loadConfigMock.mockResolvedValue(
      makeConfig({ projectDir, knownRepositories: ["owner/repo", "bare"] }),
    );

    await setupReposCli([]);

    expect(process.exitCode).toBe(1);
  });

  it("sets process.exitCode = 1 when an existing target is invalid", async () => {
    mkdirSync(join(projectDir, "owner", "repo"), { recursive: true });
    writeFileSync(join(projectDir, "owner", "repo", "README.md"), "not a clone");

    await setupReposCli([]);

    expect(process.exitCode).toBe(1);
  });

  it("leaves process.exitCode unset when every repo is already present", async () => {
    makeGitRepositoryTarget("owner", "repo");

    await setupReposCli([]);

    expect(process.exitCode).toBeUndefined();
  });
});
