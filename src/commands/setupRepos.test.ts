import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { findConfigFilepath, loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { addRepositoryToConfigText, setupRepos, setupReposCli } from "./setupRepos.ts";

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
  return {
    ...actual,
    loadConfig: vi.fn<typeof loadConfig>(),
    findConfigFilepath: vi.fn<typeof findConfigFilepath>(),
  };
});

const whichMock = vi.mocked(which);
const loadConfigMock = vi.mocked(loadConfig);
const findConfigFilepathMock = vi.mocked(findConfigFilepath);

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
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

describe(addRepositoryToConfigText, () => {
  it("appends a new entry to a single-line array", () => {
    const input = `export default {
  workspace: {
    projectDir: "~/dev",
    knownRepositories: ["a/b"],
  },
};
`;
    const actual = addRepositoryToConfigText(input, "c/d");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toContain(`knownRepositories: ["a/b", "c/d"]`);
  });

  it("returns alreadyPresent: true when the entry exists (single-line)", () => {
    const input = `knownRepositories: ["a/b", "c/d"]`;

    const actual = addRepositoryToConfigText(input, "c/d");

    expect(actual.alreadyPresent).toBe(true);
    expect(actual.text).toBe(input);
  });

  it("appends to a multi-line array preserving indentation", () => {
    const input = `export default {
  workspace: {
    projectDir: "~/dev",
    knownRepositories: [
      "a/b",
      "c/d",
    ],
  },
};
`;
    const actual = addRepositoryToConfigText(input, "e/f");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toContain(`      "a/b",\n      "c/d",\n      "e/f",\n    ],`);
  });

  it("adds a trailing comma when the multi-line array lacked one", () => {
    const input = `knownRepositories: [
  "a/b",
  "c/d"
]`;
    const actual = addRepositoryToConfigText(input, "e/f");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toContain(`"c/d",\n  "e/f",\n]`);
  });

  it("treats the array as empty when written as []", () => {
    const input = `knownRepositories: []`;

    const actual = addRepositoryToConfigText(input, "new/repo");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toBe(`knownRepositories: ["new/repo"]`);
  });

  it("handles single-quoted entries (detects existing values)", () => {
    const input = `knownRepositories: ['a/b']`;

    const actual = addRepositoryToConfigText(input, "a/b");

    expect(actual.alreadyPresent).toBe(true);
  });

  it("throws when the knownRepositories key cannot be located", () => {
    const input = `export default { workspace: { projectDir: "~/dev" } };`;

    expect(() => addRepositoryToConfigText(input, "new/repo")).toThrow(
      /Could not locate.*knownRepositories/,
    );
  });

  it("ignores a JSDoc occurrence and edits the real declaration", () => {
    const input = `/**
 * Example: workspace: { knownRepositories: ["foo/bar"] }
 */
export default {
  workspace: {
    knownRepositories: ["a/b"],
  },
};
`;
    const actual = addRepositoryToConfigText(input, "new/repo");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toContain(`knownRepositories: ["foo/bar"]`); // comment untouched
    expect(actual.text).toContain(`knownRepositories: ["a/b", "new/repo"]`); // real edit
  });

  it("ignores a line-comment occurrence and edits the real declaration", () => {
    const input = `// Old config: knownRepositories: ["x/y"]
knownRepositories: ["a/b"]
`;
    const actual = addRepositoryToConfigText(input, "new/repo");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toBe(
      `// Old config: knownRepositories: ["x/y"]\nknownRepositories: ["a/b", "new/repo"]\n`,
    );
  });

  it("treats a commented-out entry inside the array as absent (does not double-add)", () => {
    const input = `knownRepositories: [
  "a/b",
  // "c/d", disabled for now
]`;
    const actual = addRepositoryToConfigText(input, "c/d");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toContain(`"a/b",\n  // "c/d", disabled for now\n  "c/d",\n]`);
  });

  it("preserves an entry whose string content contains a literal ]", () => {
    const input = `knownRepositories: ["weird]name", "a/b"]`;

    const actual = addRepositoryToConfigText(input, "new/repo");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toBe(`knownRepositories: ["weird]name", "a/b", "new/repo"]`);
  });

  it("throws when an entry is written as a template literal (cannot safely rewrite)", () => {
    const input = "knownRepositories: [`a/b`]";

    expect(() => addRepositoryToConfigText(input, "new/repo")).toThrow(
      /template-literal.*Add.*by hand/i,
    );
  });

  it("handles CRLF line endings in a multi-line array and preserves CRLF on the inserted line", () => {
    const input = `knownRepositories: [\r\n  "a/b",\r\n  "c/d",\r\n]`;

    const actual = addRepositoryToConfigText(input, "e/f");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toBe(`knownRepositories: [\r\n  "a/b",\r\n  "c/d",\r\n  "e/f",\r\n]`);
  });

  it("keeps positions aligned when a nearby comment contains an astral character (emoji)", () => {
    // Astral characters (4-byte UTF-8 / surrogate-pair UTF-16) inside a
    // masked region must not shrink the masked string's code-unit length —
    // otherwise the `match.indices` returned by the regex would slice the
    // wrong bytes from the original text. The fishing-pole emoji ('🎣') is a
    // surrogate-pair character (two UTF-16 code units).
    const input = `// 🎣 known repos live here
knownRepositories: ["a/b"]
`;

    const actual = addRepositoryToConfigText(input, "new/repo");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toBe(
      `// 🎣 known repos live here\nknownRepositories: ["a/b", "new/repo"]\n`,
    );
  });

  it("does not misinterpret backslash-escape sequences in surrounding strings", () => {
    // The Windows-style path contains backslash-escape sequences (`\\U`, `\\m`)
    // that the masker must consume without exiting the string state — otherwise
    // a stray `"` inside the masked output could shift the `knownRepositories`
    // match.
    const input = `export default {
  workspace: {
    projectDir: "C:\\\\Users\\\\me\\\\dev",
    knownRepositories: ["a/b"],
  },
};`;

    const actual = addRepositoryToConfigText(input, "c/d");

    expect(actual.alreadyPresent).toBe(false);
    expect(actual.text).toContain(`knownRepositories: ["a/b", "c/d"]`);
    expect(actual.text).toContain(`projectDir: "C:\\\\Users\\\\me\\\\dev"`);
  });
});

describe(setupRepos, () => {
  let projectDir: string;
  let configFilepath: string;
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "groundcrew-setup-repos-"));
    configFilepath = join(projectDir, "crew.config.ts");
    writeFileSync(
      configFilepath,
      `export default {
  workspace: {
    projectDir: "${projectDir}",
    knownRepositories: ["existing/repo"],
  },
};
`,
    );
    consoleLog = captureConsoleLog();
    whichMock.mockResolvedValue("/usr/local/bin/gh");
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(projectDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("adds the repository to config and clones via gh repo clone", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "new/repo" });

    expect(actual.configChange).toBe("added");
    expect(actual.cloneChange).toBe("cloned");
    expect(readFileSync(configFilepath, "utf8")).toContain(
      `knownRepositories: ["existing/repo", "new/repo"]`,
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "new/repo", join(projectDir, "new/repo")],
      expect.objectContaining({ stdio: "inherit", timeoutMs: 0 }),
    );
  });

  it("creates the owner parent directory before cloning", async () => {
    runCommandMock.mockImplementationOnce((_command, arguments_) => {
      const { 3: target = "" } = arguments_;
      expect(existsSync(dirname(target))).toBe(true);
      return "";
    });
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    await setupRepos(config, configFilepath, { repository: "owner/repo" });

    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });

  it("skips config edit when the repo is already in knownRepositories", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });
    const originalText = readFileSync(configFilepath, "utf8");

    const actual = await setupRepos(config, configFilepath, { repository: "existing/repo" });

    expect(actual.configChange).toBe("already-present");
    expect(readFileSync(configFilepath, "utf8")).toBe(originalText);
  });

  it("skips clone when the target already exists as a directory (already cloned)", async () => {
    mkdirSync(join(projectDir, "new/repo", ".git"), { recursive: true });
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "new/repo" });

    expect(actual.cloneChange).toBe("already-cloned");
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("skips clone for bare-name entries (no owner/) but still updates config", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "bare" });

    expect(actual.configChange).toBe("added");
    expect(actual.cloneChange).toBe("skipped-bare-name");
    expect(readFileSync(configFilepath, "utf8")).toContain(`"bare"`);
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toMatch(/bare name.*owner.*prefix/i);
  });

  it("reports gh-missing when the gh CLI is not on PATH", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- exercises the gh-missing branch
    whichMock.mockResolvedValue(undefined);
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "new/repo" });

    expect(actual.configChange).toBe("added");
    expect(actual.cloneChange).toBe("gh-missing");
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toMatch(/gh CLI not found/);
  });

  it("reports a failed clone without throwing", async () => {
    runCommandMock.mockImplementationOnce(() => {
      throw new Error("clone failed");
    });
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "new/repo" });

    expect(actual.cloneChange).toBe("failed");
    expect(actual.cloneError?.message).toBe("clone failed");
  });

  it("wraps a non-Error thrown value from the clone subprocess", async () => {
    runCommandMock.mockImplementationOnce(() => {
      // oxlint-disable-next-line no-throw-literal,typescript/only-throw-error -- exercising the non-Error throw branch
      throw "raw string failure";
    });
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "new/repo" });

    expect(actual.cloneChange).toBe("failed");
    expect(actual.cloneError?.message).toBe("raw string failure");
  });

  it("rejects an empty repository identifier", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    await expect(setupRepos(config, configFilepath, { repository: "" })).rejects.toThrow(
      /non-empty/i,
    );
  });

  it("rejects a repository with empty segments (e.g. owner/)", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    await expect(setupRepos(config, configFilepath, { repository: "owner/" })).rejects.toThrow(
      /Invalid repository/,
    );
  });

  it("rejects a repository with too many slash segments", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    await expect(setupRepos(config, configFilepath, { repository: "a/b/c" })).rejects.toThrow(
      /Invalid repository/,
    );
  });

  it("rejects a repository whose target resolves outside projectDir", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    await expect(setupRepos(config, configFilepath, { repository: "../escape" })).rejects.toThrow(
      /outside workspace.projectDir/,
    );
  });

  it("does not edit the config or clone under --dry-run", async () => {
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });
    const originalText = readFileSync(configFilepath, "utf8");

    const actual = await setupRepos(config, configFilepath, {
      repository: "new/repo",
      dryRun: true,
    });

    expect(actual.configChange).toBe("would-add");
    expect(actual.cloneChange).toBe("would-clone");
    expect(readFileSync(configFilepath, "utf8")).toBe(originalText);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("reports already-present + would-clone under --dry-run after a crashed first run", async () => {
    // Simulates the recovery state: config edit was already written by a
    // prior invocation, but the clone never ran (target dir missing).
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, {
      repository: "existing/repo",
      dryRun: true,
    });

    expect(actual.configChange).toBe("already-present");
    expect(actual.cloneChange).toBe("would-clone");
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("reports skipped-target-not-directory when the target is a file", async () => {
    writeFileSync(join(projectDir, "new"), "not a directory");
    const config = makeConfig({ projectDir, knownRepositories: ["existing/repo"] });

    const actual = await setupRepos(config, configFilepath, { repository: "new" });

    expect(actual.cloneChange).toBe("skipped-target-not-directory");
  });
});

describe(setupReposCli, () => {
  let projectDir: string;
  let configFilepath: string;
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "groundcrew-setup-repos-cli-"));
    configFilepath = join(projectDir, "crew.config.ts");
    writeFileSync(
      configFilepath,
      `export default {
  workspace: {
    projectDir: "${projectDir}",
    knownRepositories: ["existing/repo"],
  },
};
`,
    );
    consoleLog = captureConsoleLog();
    process.exitCode = undefined;
    whichMock.mockResolvedValue("/usr/local/bin/gh");
    runCommandMock.mockReturnValue("");
    loadConfigMock.mockResolvedValue(
      makeConfig({ projectDir, knownRepositories: ["existing/repo"] }),
    );
    findConfigFilepathMock.mockResolvedValue(configFilepath);
  });

  afterEach(() => {
    consoleLog.restore();
    process.exitCode = undefined;
    rmSync(projectDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("rejects when no <new-repo> positional is given", async () => {
    await expect(setupReposCli([])).rejects.toThrow(/Usage: crew setup repos/);
  });

  it("rejects when more than one positional is given", async () => {
    await expect(setupReposCli(["a/b", "c/d"])).rejects.toThrow(/Usage: crew setup repos/);
  });

  it("clones a single repo through the full pipeline", async () => {
    await setupReposCli(["new/repo"]);

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(findConfigFilepathMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "new/repo", join(projectDir, "new/repo")],
      expect.objectContaining({ stdio: "inherit", timeoutMs: 0 }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exit code 1 when gh is missing", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- exercises the gh-missing branch
    whichMock.mockResolvedValue(undefined);

    await setupReposCli(["new/repo"]);

    expect(process.exitCode).toBe(1);
  });

  it("sets exit code 1 when the entry is bare (manual clone required)", async () => {
    await setupReposCli(["bare"]);

    expect(process.exitCode).toBe(1);
  });

  it("does not set exit code 1 when the repo is already in config and cloned", async () => {
    mkdirSync(join(projectDir, "existing/repo", ".git"), { recursive: true });

    await setupReposCli(["existing/repo"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("forwards --dry-run through to setupRepos", async () => {
    const originalText = readFileSync(configFilepath, "utf8");

    await setupReposCli(["--dry-run", "new/repo"]);

    expect(readFileSync(configFilepath, "utf8")).toBe(originalText);
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});
