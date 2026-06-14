import { repositoryBaseDir, worktreeBaseDir, type ResolvedConfig } from "./config.ts";

function resolvedConfigWithWorkspace(
  workspace: Omit<ResolvedConfig["workspace"], "repositories"> & {
    repositories?: ResolvedConfig["workspace"]["repositories"];
  },
): ResolvedConfig {
  return {
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      ...workspace,
      repositories: workspace.repositories ?? workspace.knownRepositories.map((name) => ({ name })),
    },
    defaults: { hooks: {} },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto", clearance: { enabled: true } },
    logging: { file: "/tmp/x.log" },
  };
}

describe("workspace path accessors", () => {
  const resolved = resolvedConfigWithWorkspace;

  it("worktreeBaseDir falls back to projectDir when worktreeDir is unset", () => {
    const config = resolved({ projectDir: "/p", knownRepositories: ["a"] });
    expect(worktreeBaseDir(config)).toBe("/p");
  });

  it("worktreeBaseDir prefers worktreeDir when set", () => {
    const config = resolved({
      projectDir: "/p",
      worktreeDir: "/w",
      knownRepositories: ["a"],
    });
    expect(worktreeBaseDir(config)).toBe("/w");
  });

  it("repositoryBaseDir falls back to projectDir without an override", () => {
    const config = resolved({ projectDir: "/p", knownRepositories: ["a"] });
    expect(repositoryBaseDir(config, "a")).toBe("/p");
  });

  it("repositoryBaseDir uses the per-repo override when present", () => {
    const config = resolved({
      projectDir: "/p",
      knownRepositories: ["a", "b"],
      repositoryDirs: { b: "/other" },
    });
    expect(repositoryBaseDir(config, "b")).toBe("/other");
    expect(repositoryBaseDir(config, "a")).toBe("/p");
  });
});
