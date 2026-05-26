import { existsSync, statSync } from "node:fs";

import type { LinearClient } from "@linear/sdk";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import type { UsageByModel } from "../lib/usage.ts";
import { getLinearClient, readEnvironmentVariable } from "../lib/util.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { doctor } from "./doctor.ts";

interface NodeFsMock {
  existsSync: ReturnType<typeof vi.fn<typeof existsSync>>;
  statSync: ReturnType<typeof vi.fn<typeof statSync>>;
}

vi.mock(
  "node:fs",
  (): NodeFsMock => ({
    existsSync: vi.fn<typeof existsSync>(),
    statSync: vi.fn<typeof statSync>(),
  }),
);
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());
const getLinearClientMock = vi.hoisted(() => vi.fn<() => LinearClient>());
const getUsageByModelMock = vi.hoisted(() =>
  vi.fn<(config: ResolvedConfig, signal?: AbortSignal) => Promise<UsageByModel>>(),
);

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/usage.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getUsageByModel: getUsageByModelMock };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getLinearClient: getLinearClientMock };
});

const existsMock = vi.mocked(existsSync);
const statMock = vi.mocked(statSync);
const loadConfigMock = vi.mocked(loadConfig);
const detectHostMock = vi.mocked(detectHostCapabilities);
const getLinearClientMocked = vi.mocked(getLinearClient);

interface RawIssueStub {
  id: string;
  title: string;
  description: string | null;
  team: { id: string } | null;
  state: { name: string; type: string } | null;
  labels: { nodes: { name: string }[] };
  inverseRelations: {
    nodes: {
      type: string;
      issue?: {
        identifier: string;
        title: string;
        state?: { name: string; type?: string } | null;
      } | null;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  };
}

type LinearRawRequest = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

function makeConfig(overrides: Partial<ResolvedConfig["models"]> = {}): ResolvedConfig {
  return {
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: {
        claude: { cmd: "safehouse claude --permission-mode auto", color: "#fff" },
      },
      ...overrides,
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

function statsWithDirectoryValue(isDirectory: boolean): ReturnType<typeof statSync> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests only need the statSync isDirectory surface
  return { isDirectory: () => isDirectory } as ReturnType<typeof statSync>;
}

function firstArgument(arguments_: unknown): string {
  if (Array.isArray(arguments_) && typeof arguments_[0] === "string") {
    return arguments_[0];
  }
  return "";
}

function checkedCommands(): string[] {
  return runCommandMock.mock.calls
    .map((call) => firstArgument(call[1]))
    .filter((token) => token.length > 0);
}

function mockWhichFailure(target: string, message: string): void {
  runCommandMock.mockImplementation((_cmd, arguments_) => {
    const candidate = firstArgument(arguments_);
    if (candidate === target) {
      throw new Error(message);
    }
    return `/usr/bin/${candidate}\n`;
  });
}

function mockWhichEmpty(target: string): void {
  runCommandMock.mockImplementation((_cmd, arguments_) => {
    const candidate = firstArgument(arguments_);
    return candidate === target ? "" : `/usr/bin/${candidate}\n`;
  });
}

function mockMissingPath(missingPath: string): void {
  existsMock.mockImplementation((path) => path !== missingPath);
}

function rawIssue(overrides: Partial<RawIssueStub> = {}): RawIssueStub {
  return {
    id: "uuid-1",
    title: "Fix the thing",
    description: "Touches repo-a.",
    team: { id: "team-default" },
    state: { name: "Todo", type: "unstarted" },
    labels: { nodes: [{ name: "agent-claude" }] },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "" } },
    ...overrides,
  };
}

interface ActiveNodeStub {
  id: string;
  state: { type: string };
}

function activeNodes(count: number): ActiveNodeStub[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `active-${index}`,
    state: { type: "started" },
  }));
}

function makeLinearClient(
  options: {
    issue?: RawIssueStub | null;
    activePages?: number[];
  } = {},
): LinearClient {
  const { issue = rawIssue(), activePages = [0] } = options;
  let activePageIndex = 0;
  let blockerPageIndex = 0;
  const rawRequest = vi.fn<LinearRawRequest>(async (query) => {
    if (query.includes("ResolveIssue")) {
      return { data: { issue } };
    }
    if (query.includes("IssueBlockers")) {
      if (issue === null) {
        return { data: { issue: null } };
      }
      const isFirstPage = blockerPageIndex === 0;
      blockerPageIndex += 1;
      const hasNextPage = isFirstPage && issue.inverseRelations.pageInfo.hasNextPage;
      return {
        data: {
          issue: {
            inverseRelations: {
              nodes: isFirstPage ? issue.inverseRelations.nodes : [],
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? issue.inverseRelations.pageInfo.endCursor : "",
              },
            },
          },
        },
      };
    }
    if (query.includes("InProgressIssues")) {
      const index = activePageIndex;
      activePageIndex += 1;
      const count = activePages[index] ?? 0;
      const hasNextPage = index < activePages.length - 1;
      return {
        data: {
          issues: {
            nodes: activeNodes(count),
            pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${index}` : "" },
          },
        },
      };
    }
    return { data: {} };
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests provide only the LinearClient surface consumed by doctor diagnostics.
  return { client: { rawRequest } } as unknown as LinearClient;
}

describe(doctor, () => {
  let consoleLog: ConsoleCapture;
  const originalGroundcrewKey = readEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
  const originalLinearKey = readEnvironmentVariable("LINEAR_API_KEY");

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    setEnvironmentVariable("LINEAR_API_KEY", "lin_api_test");
    existsMock.mockReturnValue(true);
    statMock.mockReturnValue(statsWithDirectoryValue(true));
    detectHostMock.mockResolvedValue(host());
    runCommandMock.mockImplementation((_cmd, arguments_) => {
      const target = firstArgument(arguments_);
      return `/usr/bin/${target}\n`;
    });
    getLinearClientMocked.mockReturnValue(makeLinearClient());
    getUsageByModelMock.mockResolvedValue({});
  });

  afterEach(() => {
    consoleLog.restore();
    if (originalGroundcrewKey === undefined) {
      deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", originalGroundcrewKey);
    }
    if (originalLinearKey === undefined) {
      deleteEnvironmentVariable("LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("LINEAR_API_KEY", originalLinearKey);
    }
    vi.resetAllMocks();
  });

  it("returns true for a dispatch-ready ticket diagnostic", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(true);
    const output = consoleLog.output();
    expect(output).toContain("groundcrew doctor --ticket TEAM-1");
    expect(output).toContain("[ok] Ticket exists in Linear");
    expect(output).toContain("[ok] Status is Todo");
    expect(output).toContain("[ok] In-progress cap not hit");
    expect(output).toContain("would be dispatched on next tick");
  });

  it("returns false when config loading fails for a ticket diagnostic", async () => {
    loadConfigMock.mockRejectedValue(new Error("bad config"));

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("config: bad config");
  });

  it("returns false when the ticket is not found", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(makeLinearClient({ issue: null }));

    const actual = await doctor({ ticket: "team-999" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("unresolvable: Ticket TEAM-999 not found in Linear");
  });

  it("returns false when the ticket is not in the Todo status", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({
        issue: rawIssue({ state: { name: "In Review", type: "started" } }),
      }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("status is In Review");
    expect(consoleLog.output()).toContain("need unstarted");
  });

  it("returns false when the ticket has no agent label", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({ issue: rawIssue({ labels: { nodes: [] } }) }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("ticket has no agent-* label");
  });

  it("returns false when the description does not mention a known repo", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({ issue: rawIssue({ description: "no repo here" }) }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("description does not mention a known repo");
  });

  it("returns false when the resolved repo is not cloned locally", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockMissingPath("/work/repo-a");

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("resolved repo repo-a is not cloned locally");
  });

  it("returns false when the ticket has active blockers", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({
        issue: rawIssue({
          inverseRelations: {
            nodes: [
              {
                type: "blocks",
                issue: {
                  identifier: "TEAM-0",
                  title: "Blocker",
                  state: { name: "In Progress", type: "started" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "" },
          },
        }),
      }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("blocked by team-0:In Progress");
  });

  it("treats blockers with missing status as active", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({
        issue: rawIssue({
          inverseRelations: {
            nodes: [
              {
                type: "blocks",
                issue: {
                  identifier: "TEAM-0",
                  title: "Blocker",
                  state: null,
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "" },
          },
        }),
      }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("blocked by team-0:missing");
  });

  it("returns false when blocker relations are paginated", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({
        issue: rawIssue({
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "blockers-cursor-1" },
          },
        }),
      }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("blockers exceeded the v1 relation page size");
  });

  it("returns false when the resolved model is over its usage limit", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getUsageByModelMock.mockResolvedValue({
      claude: {
        session: 0.94,
        sessionEndDuration: null,
        weekly: null,
        weekEndDuration: null,
      },
    });

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("claude session usage 94% over 85% limit");
  });

  it("returns false when the resolved model exceeds the weekly paced budget", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getUsageByModelMock.mockResolvedValue({
      claude: {
        session: 0.1,
        sessionEndDuration: 30,
        weekly: 0.2,
        weekEndDuration: 6 * 24 * 60,
      },
    });

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("claude weekly usage 20.0% over 14.3% paced budget");
  });

  it("treats null model session usage as available capacity", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getUsageByModelMock.mockResolvedValue({
      claude: {
        session: null,
        sessionEndDuration: null,
        weekly: null,
        weekEndDuration: null,
      },
    });

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain('Model "claude" usage under sessionLimitPercentage');
  });

  it("returns false when the in-progress cap is hit", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(makeLinearClient({ activePages: [4] }));

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("in-progress cap is full (4/4 used)");
  });

  it("resolves agent-any before checking usage", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({ issue: rawIssue({ labels: { nodes: [{ name: "agent-any" }] } }) }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain('agent-any resolved to model "claude"');
  });

  it("returns false when agent-any has no model with available capacity", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({ issue: rawIssue({ labels: { nodes: [{ name: "agent-any" }] } }) }),
    );
    getUsageByModelMock.mockResolvedValue({
      claude: {
        session: 0.94,
        sessionEndDuration: null,
        weekly: null,
        weekEndDuration: null,
      },
    });

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("agent-any has no model with available capacity");
  });

  it("reports disabled shipped-default fallback labels", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    getLinearClientMocked.mockReturnValue(
      makeLinearClient({ issue: rawIssue({ labels: { nodes: [{ name: "agent-codex" }] } }) }),
    );

    const actual = await doctor({ ticket: "team-1" });

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain('agent-codex disabled; falling back to model "claude"');
  });

  it("returns false when config loading fails", async () => {
    loadConfigMock.mockRejectedValue(new Error("bad config"));

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("config: bad config");
  });

  it("returns false when host-capability probing throws", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    detectHostMock.mockRejectedValue(new Error("probe blew up"));

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("host: probe blew up");
  });

  it("returns true when all required checks pass", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("All required checks passed");
  });

  it("returns false and reports both env var names when neither key is set", async () => {
    deleteEnvironmentVariable("LINEAR_API_KEY");
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(false);
    const output = consoleLog.output();
    expect(output).toContain("linear api key");
    expect(output).toContain("$GROUNDCREW_LINEAR_API_KEY");
    expect(output).toContain("$LINEAR_API_KEY");
  });

  it("reports the resolved env var when only GROUNDCREW_LINEAR_API_KEY is set", async () => {
    deleteEnvironmentVariable("LINEAR_API_KEY");
    setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    const output = consoleLog.output();
    expect(output).toContain("linear api key");
    expect(output).toContain("$GROUNDCREW_LINEAR_API_KEY");
  });

  it("prefers GROUNDCREW_LINEAR_API_KEY in doctor output when both env vars are set", async () => {
    setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");
    setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    const output = consoleLog.output();
    expect(output).toContain("$GROUNDCREW_LINEAR_API_KEY");
    expect(output).not.toMatch(/set via \$LINEAR_API_KEY/);
  });

  it("returns false when a required CLI tool is missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockWhichFailure("git", "not found");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("[--] git");
  });

  it("treats an empty `which` result as missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockWhichEmpty("cmux");

    const actual = await doctor();

    expect(actual).toBe(false);
  });

  it("hints to mkdir -p when the workspace dir is missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockMissingPath("/work");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain('mkdir -p "/work"');
  });

  it("treats a non-directory project path as missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    statMock.mockReturnValue(statsWithDirectoryValue(false));

    const actual = await doctor();

    expect(actual).toBe(false);
  });

  it("handles statSync throwing as a missing directory", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    statMock.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const actual = await doctor();

    expect(actual).toBe(false);
  });

  it("checks both wrapper and wrapped commands when the cmd is `safehouse claude --foo`", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());

    await doctor();

    const checked = checkedCommands();
    expect(checked).toContain("safehouse");
    expect(checked).toContain("claude");
  });

  it("skips flag values when tokenizing model commands", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "node-cli",
        definitions: {
          "node-cli": { cmd: "node --inspect script.ts", color: "#fff" },
        },
      }),
    );

    await doctor();

    const checked = checkedCommands();
    expect(checked).toContain("node");
    expect(checked).not.toContain("script.ts");
  });

  it("does not probe a disabled shipped default's CLI binary", async () => {
    // The default makeConfig fixture has only `claude` in `definitions` — the
    // same shape `mergeDefinitions` produces for `codex: { disabled: true }`.
    // `gatherToolTokens` iterates `Object.values(definitions)`, so codex is
    // never gathered.
    loadConfigMock.mockResolvedValue(makeConfig());

    await doctor();

    const checked = checkedCommands();
    expect(checked).not.toContain("codex");
    expect(checked).toContain("claude");
  });

  it("reports missing Safehouse as a local runner warning", async () => {
    detectHostMock.mockResolvedValue(host({ hasSafehouse: false }));
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("local runner (safehouse)");
    expect(consoleLog.output()).toContain(
      "safehouse runner requires macOS with `safehouse` on PATH",
    );
    expect(consoleLog.output().match(/local runner \(safehouse\)/g)).toHaveLength(1);
  });

  it("reports the sdx runner as ready when auto picks sdx on Linux and sbx is on PATH", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        hasSbx: true,
        hasCmux: false,
        hasTmux: true,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: auto → resolved: sdx");
    expect(consoleLog.output()).toContain("local runner (sdx)");
    expect(consoleLog.output()).not.toContain("sdx runner requires `sbx`");
  });

  it("reports the sdx runner as missing when sbx is not on PATH", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        hasSbx: false,
        hasCmux: false,
        hasTmux: true,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("local runner (sdx)");
    expect(consoleLog.output()).toContain("sdx runner requires `sbx`");
  });

  it("surfaces a WARNING when local.runner is configured to 'none'", async () => {
    detectHostMock.mockResolvedValue(host());
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "none" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: none → resolved: none");
    expect(consoleLog.output()).toContain("local runner (none)");
    expect(consoleLog.output()).toContain("WARNING: local.runner='none'");
  });

  it("honours an explicit local.runner='sdx' even on macOS, reflecting the requested vs resolved line", async () => {
    detectHostMock.mockResolvedValue(host({ hasSbx: true }));
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "sdx" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: sdx → resolved: sdx");
    expect(consoleLog.output()).toContain("local runner (sdx)");
  });

  it("downgrades model command checks to optional when the local runner is unavailable", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        hasCmux: false,
        hasTmux: true,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue(
      makeConfig({
        definitions: {
          claude: { cmd: "missing-cli", color: "#fff" },
        },
      }),
    );
    mockWhichFailure("missing-cli", "not installed");

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("[? ] missing-cli");
    expect(consoleLog.output()).toContain("required for local runs");
  });

  it("fails doctor when codexbar is missing and an enabled model has usage configured", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "claude",
        definitions: {
          claude: {
            cmd: "claude",
            color: "#fff",
            usage: { codexbar: { provider: "claude", source: "oauth" } },
          },
        },
      }),
    );
    mockWhichFailure("codexbar", "not installed");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain(
      "[--] codexbar  — required for usage gating on `claude` — install codexbar, or set `models.definitions.<name>.usage` to disable gating",
    );
  });

  it("reports codexbar as ok when usage is configured and codexbar is on PATH", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "claude",
        definitions: {
          claude: {
            cmd: "claude",
            color: "#fff",
            usage: { codexbar: { provider: "claude", source: "oauth" } },
          },
        },
      }),
    );
    // Make every `which` succeed (no target throws), so codexbar resolves.
    mockWhichFailure("__never__", "unreachable");

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("[ok] codexbar");
  });

  it("omits the hint when both `which` and the caller produce nothing", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "bare",
        definitions: {
          bare: { cmd: "bare-cli", color: "#fff" },
        },
      }),
    );
    mockWhichFailure("bare-cli", "missing");

    await doctor();

    expect(consoleLog.output()).toMatch(/\[--] bare-cli\s*$/m);
  });

  it("treats the token after a leading flag as the flag's value and stops after MAX tokens", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "deep",
        definitions: {
          deep: { cmd: "--leading-flag a b c", color: "#fff" },
        },
      }),
    );

    await doctor();

    const checked = checkedCommands();
    expect(checked).not.toContain("a");
    expect(checked).toContain("b");
    expect(checked).toContain("c");
  });

  it("handles trailing flags whose value is missing", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "trailing",
        definitions: {
          trailing: { cmd: "alpha --tail", color: "#fff" },
        },
      }),
    );

    await doctor();

    const checked = checkedCommands();
    expect(checked).toContain("alpha");
  });

  it("reports the local-runner check as a warning while accepting cmux workspaces", async () => {
    detectHostMock.mockResolvedValue(
      host({ hasSafehouse: false, isMacOS: false, isLinux: true, isSafehouseSupported: false }),
    );
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    const lines = consoleLog.output();
    expect(lines).toContain("Local runner");
    expect(lines).toContain("sdx runner requires `sbx`");
    expect(lines).toMatch(/requested=auto, resolved=cmux/);
    expect(checkedCommands()).toContain("cmux");
    expect(checkedCommands()).not.toContain("tmux");
    expect(lines).not.toContain("sbx diagnose");
  });

  it("checks tmux instead of cmux when workspaceKind resolves to tmux", async () => {
    detectHostMock.mockResolvedValue(host({ hasCmux: false, hasTmux: true }));
    loadConfigMock.mockResolvedValue({
      ...makeConfig(),
      workspaceKind: "tmux",
    });

    const actual = await doctor();

    expect(actual).toBe(true);
    const lines = consoleLog.output();
    expect(lines).toMatch(/requested=tmux, resolved=tmux/);
    expect(checkedCommands()).toContain("tmux");
    expect(checkedCommands()).not.toContain("cmux");
  });

  it("reports a workspaceKind failure when the chosen backend's binary is missing", async () => {
    detectHostMock.mockResolvedValue(host({ hasCmux: false }));
    loadConfigMock.mockResolvedValue({ ...makeConfig(), workspaceKind: "cmux" });

    const actual = await doctor();

    expect(actual).toBe(false);
    const lines = consoleLog.output();
    expect(lines).toMatch(/requested=cmux/);
    expect(lines).toContain("cmux binary is not on PATH");
  });
});
