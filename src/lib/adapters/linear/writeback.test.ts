import type { LinearClient } from "@linear/sdk";

import { captureConsoleLog, type ConsoleCapture } from "../../../testHelpers/consoleCapture.ts";
import type { ResolvedConfig } from "../../config.ts";
import { createLinearIssueStatusUpdater } from "./writeback.ts";

interface ClientStub {
  team: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
}

function makeClient(options: { omitInProgressState?: boolean } = {}): ClientStub {
  const { omitInProgressState = false } = options;
  return {
    team: vi
      .fn<() => Promise<{ states: () => Promise<{ nodes: { id: string; name: string }[] }> }>>()
      .mockResolvedValue({
        states: vi
          .fn<() => Promise<{ nodes: { id: string; name: string }[] }>>()
          .mockResolvedValue({
            nodes: omitInProgressState
              ? [{ id: "state-other", name: "Other" }]
              : [{ id: "state-in-progress", name: "In Progress" }],
          }),
      }),
    updateIssue: vi.fn<() => Promise<Record<string, never>>>().mockResolvedValue({}),
  };
}

function asLinearClient(stub: ClientStub): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by writeback
  return stub as unknown as LinearClient;
}

function makeConfig(): ResolvedConfig {
  return {
    linear: {
      projects: [
        {
          projectSlug: "ai-strategy-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
    },
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
    orchestrator: {
      maximumInProgress: 2,
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

describe(createLinearIssueStatusUpdater, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
  });

  afterEach(() => {
    consoleLog.restore();
    vi.clearAllMocks();
  });

  it("fetches the In-Progress state once across multiple tickets in the same team", async () => {
    const client = makeClient();
    const updater = createLinearIssueStatusUpdater({
      config: makeConfig(),
      client: asLinearClient(client),
    });

    await updater.markInProgress({
      id: "team-1",
      uuid: "uuid-1",
      teamId: "shared",
      projectSlugId: "aaaaaaaaaaaa",
    });
    await updater.markInProgress({
      id: "team-2",
      uuid: "uuid-2",
      teamId: "shared",
      projectSlugId: "aaaaaaaaaaaa",
    });

    expect(client.team).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledTimes(2);
  });

  it("re-fetches team workflow states on every failing markInProgress so an operator-side fix is picked up without restart", async () => {
    // No negative cache: a team missing its inProgress workflow state is a
    // Linear-side config issue the operator can correct mid-session. The
    // previous design cached the failure and required a process restart to
    // recover; this test pins the re-fetch behavior.
    const client = makeClient({ omitInProgressState: true });
    const updater = createLinearIssueStatusUpdater({
      config: makeConfig(),
      client: asLinearClient(client),
    });

    await expect(
      updater.markInProgress({
        id: "team-1",
        uuid: "uuid-1",
        teamId: "broken",
        projectSlugId: "aaaaaaaaaaaa",
      }),
    ).rejects.toThrow('Could not find "In Progress" state');
    await expect(
      updater.markInProgress({
        id: "team-2",
        uuid: "uuid-2",
        teamId: "broken",
        projectSlugId: "aaaaaaaaaaaa",
      }),
    ).rejects.toThrow('Could not find "In Progress" state');

    expect(client.team).toHaveBeenCalledTimes(2);
  });
});
