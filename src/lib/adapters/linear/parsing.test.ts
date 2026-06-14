import type { ResolvedConfig } from "../../config.ts";
import { RepositoryResolutionError } from "../../taskSource.ts";
import {
  buildRepositoryRegex,
  parseRepository,
  resolveAgentFor,
  resolveRepositoryFor,
} from "./parsing.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a", "repo-b", "api", "api-admin"],
      repositories: [
        { name: "repo-a" },
        { name: "repo-b" },
        { name: "api" },
        { name: "api-admin" },
      ],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    agents: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.agents,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", clearance: { enabled: true } },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

describe(parseRepository, () => {
  const repositoryRegex = /\b(?<repo>org\/repo-a|repo-a|repo-b|repo-x\/bare)\b/;

  it("returns the matched known repository when it is in knownRepositories", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["org/repo-a", "repo-b"],
        repositories: [{ name: "org/repo-a" }, { name: "repo-b" }],
      },
    });
    const result = parseRepository({
      description: "fix the org/repo-a bug",
      config,
      repositoryRegex,
      task: "HRD-1",
    });
    expect(result).toBe("org/repo-a");
  });

  it("returns the asserted name as-is when the match is not in knownRepositories", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["other-repo"],
        repositories: [{ name: "other-repo" }],
      },
    });
    const result = parseRepository({
      description: "touches repo-a somewhere",
      config,
      repositoryRegex,
      task: "HRD-2",
    });
    expect(result).toBe("repo-a");
  });

  it("throws RepositoryResolutionError when multiple knownRepositories match the bare name", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["org1/repo-a", "org2/repo-a"],
        repositories: [{ name: "org1/repo-a" }, { name: "org2/repo-a" }],
      },
    });
    expect(() =>
      parseRepository({
        description: "touches repo-a somewhere",
        config,
        repositoryRegex,
        task: "HRD-3",
      }),
    ).toThrow(RepositoryResolutionError);
  });

  it("throws RepositoryResolutionError when the description is empty", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["repo-a"],
        repositories: [{ name: "repo-a" }],
      },
    });
    expect(() =>
      parseRepository({
        description: "",
        config,
        repositoryRegex,
        task: "HRD-4",
      }),
    ).toThrow(RepositoryResolutionError);
  });

  it("throws RepositoryResolutionError when no repo name appears in the description", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["repo-a"],
        repositories: [{ name: "repo-a" }],
      },
    });
    expect(() =>
      parseRepository({
        description: "no repository mentioned here",
        config,
        repositoryRegex,
        task: "HRD-5",
      }),
    ).toThrow(RepositoryResolutionError);
  });
});

describe(resolveRepositoryFor, () => {
  it("returns the repository when the description mentions a known one", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["acme/widgets"],
        repositories: [{ name: "acme/widgets" }],
      },
    });
    const result = resolveRepositoryFor({
      description: "fix the acme/widgets bug",
      config,
    });
    expect(result).toStrictEqual({ kind: "ok", repository: "acme/widgets" });
  });

  it("returns missing when no known repo is in the description", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["acme/widgets"],
        repositories: [{ name: "acme/widgets" }],
      },
    });
    expect(resolveRepositoryFor({ description: "nothing here", config }).kind).toBe("missing");
  });

  it("returns missing on empty description", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["acme/widgets"],
        repositories: [{ name: "acme/widgets" }],
      },
    });
    expect(resolveRepositoryFor({ description: "", config }).kind).toBe("missing");
  });

  it("returns missing on undefined description", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["acme/widgets"],
        repositories: [{ name: "acme/widgets" }],
      },
    });
    expect(resolveRepositoryFor({ description: undefined, config }).kind).toBe("missing");
  });

  it("returns missing when knownRepositories is empty rather than matching the empty string", () => {
    // Pinned because buildRepositoryRegex over [] is /\b()\b/, which matches
    // the empty string at every word boundary — without this guard the
    // dispatch / single-task / doctor paths would all emit a bogus
    // { kind: "ok", repository: "" }.
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: [], repositories: [] },
    });
    expect(resolveRepositoryFor({ description: "anything at all", config }).kind).toBe("missing");
  });

  it("canonicalizes a bare match back to the configured `owner/repo` entry", async () => {
    // A Linear description that mentions only `repo-a` must resolve to the
    // exact knownRepositories entry `org/repo-a` so `crew run --task ...`
    // launches against the correct worktree path. Without this canonicalization
    // the single-task flow would launch against a bare `repo-a` directory.
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["org/repo-a"],
        repositories: [{ name: "org/repo-a" }],
      },
    });
    const result = resolveRepositoryFor({
      description: "fix the repo-a bug",
      config,
    });
    expect(result).toStrictEqual({ kind: "ok", repository: "org/repo-a" });
  });

  it("returns missing when the bare name maps to multiple knownRepositories", async () => {
    // Ambiguous bare-name match — the launcher can't disambiguate "matched
    // N known repos" any more than the dispatcher can, so surface as missing
    // (which fetchResolvedIssue turns into a RepositoryResolutionError).
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["org1/repo-a", "org2/repo-a"],
        repositories: [{ name: "org1/repo-a" }, { name: "org2/repo-a" }],
      },
    });
    expect(resolveRepositoryFor({ description: "touches repo-a somewhere", config }).kind).toBe(
      "missing",
    );
  });
});

describe(resolveAgentFor, () => {
  it("returns matched when label corresponds to a known agent", () => {
    const config = makeConfig();
    const result = resolveAgentFor({ labels: [{ name: "agent-claude" }], config });
    expect(result).toStrictEqual({ kind: "matched", agent: "claude" });
  });

  it("returns no-label when no agent-* label is present", () => {
    const config = makeConfig();
    const result = resolveAgentFor({ labels: [{ name: "feature" }], config });
    expect(result.kind).toBe("no-label");
  });

  it("returns no-label when the labels array is empty", () => {
    const config = makeConfig();
    const result = resolveAgentFor({ labels: [], config });
    expect(result.kind).toBe("no-label");
  });

  it("returns agent-any when the label is agent-any", () => {
    const config = makeConfig();
    const result = resolveAgentFor({ labels: [{ name: "agent-any" }], config });
    expect(result.kind).toBe("agent-any");
  });

  it("returns not-enabled-fallback when the label matches a built-in agent that is not enabled", () => {
    // codex is absent from definitions but IS a built-in agent, so the label is
    // recognizable and can produce a targeted warning before fallback.
    const configWithCodexNotEnabled = makeConfig({
      agents: {
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
        },
      },
    });
    const result = resolveAgentFor({
      labels: [{ name: "agent-codex" }],
      config: configWithCodexNotEnabled,
    });
    expect(result).toStrictEqual({
      kind: "not-enabled-fallback",
      requestedAgent: "codex",
      fallbackAgent: "claude",
    });
  });
});

describe(buildRepositoryRegex, () => {
  it("longer repository names beat shorter ones (api-admin vs api)", () => {
    const config = makeConfig();
    const regex = buildRepositoryRegex(config);
    const match = regex.exec("task about api-admin only");
    expect(match?.[1]).toBe("api-admin");
  });

  it("produces a regex that matches a full org/repo path", () => {
    const config = makeConfig({
      workspace: {
        projectDir: "/work",
        knownRepositories: ["acme/widgets"],
        repositories: [{ name: "acme/widgets" }],
      },
    });
    const regex = buildRepositoryRegex(config);
    const match = regex.exec("fix the acme/widgets bug");
    expect(match?.[1]).toBe("acme/widgets");
  });
});
