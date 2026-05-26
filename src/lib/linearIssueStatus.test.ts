import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "./config.ts";
import { createLinearIssueStatusUpdater } from "./linearIssueStatus.ts";

type RawRequestFn = (query: string, variables?: unknown) => Promise<{ data?: unknown }>;

interface MockedClient {
  client: { rawRequest: RawRequestFn };
  updateIssue: (uuid: string, args: { stateId: string }) => Promise<void>;
}

function mockClient(): MockedClient {
  return {
    client: {
      rawRequest: async () => ({ data: {} }),
    },
    updateIssue: async () => {
      /* no-op */
    },
  };
}

function asClient(client: MockedClient): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mocked surface narrows the full LinearClient via the helper
  return client as unknown as LinearClient;
}

function makeViewConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projects: [],
      views: [{ viewSlug: "v-61e51e3730dd", slugId: "61e51e3730dd" }],
      ...overrides.linear,
    },
    sources: [],
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["org/repo-a"],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    models: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto" },
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

describe("createLinearIssueStatusUpdater (view mode)", () => {
  it("markInProgress writes the lowest-position `started`-type state for the team", async () => {
    const writes: { uuid: string; stateId: string }[] = [];
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        team: {
          states: {
            nodes: [
              { id: "s2", name: "In Review", position: 200, type: "started" },
              { id: "s1", name: "In Progress", position: 100, type: "started" },
            ],
          },
        },
      },
    });
    client.updateIssue = async (uuid, args) => {
      writes.push({ uuid, stateId: args.stateId });
    };

    const updater = createLinearIssueStatusUpdater({
      config: makeViewConfig(),
      client: asClient(client),
    });
    await updater.markInProgress({
      id: "linear:eng-1",
      uuid: "issue-uuid",
      teamId: "team-1",
      projectSlugId: "",
    });
    expect(writes).toStrictEqual([{ uuid: "issue-uuid", stateId: "s1" }]);
  });

  it("markInProgress caches the started-state lookup per team", async () => {
    let callCount = 0;
    const client = mockClient();
    client.client.rawRequest = async () => {
      callCount += 1;
      return {
        data: {
          team: {
            states: {
              nodes: [{ id: "s1", name: "In Progress", position: 100, type: "started" }],
            },
          },
        },
      };
    };
    const updater = createLinearIssueStatusUpdater({
      config: makeViewConfig(),
      client: asClient(client),
    });
    await updater.markInProgress({
      id: "linear:eng-1",
      uuid: "u1",
      teamId: "team-1",
      projectSlugId: "",
    });
    await updater.markInProgress({
      id: "linear:eng-2",
      uuid: "u2",
      teamId: "team-1",
      projectSlugId: "",
    });
    expect(callCount).toBe(1);
  });

  it("markInProgress throws when the team has no `started`-type state", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({ data: { team: { states: { nodes: [] } } } });
    const updater = createLinearIssueStatusUpdater({
      config: makeViewConfig(),
      client: asClient(client),
    });
    await expect(
      updater.markInProgress({
        id: "linear:eng-1",
        uuid: "u1",
        teamId: "team-1",
        projectSlugId: "",
      }),
    ).rejects.toThrow(/team "team-1" has no workflow state with type=started/);
  });

  it("markInProgress is a no-op when teamId is empty", async () => {
    const client = mockClient();
    let rawCalled = false;
    client.client.rawRequest = async () => {
      rawCalled = true;
      return { data: {} };
    };
    const updater = createLinearIssueStatusUpdater({
      config: makeViewConfig(),
      client: asClient(client),
    });
    await expect(
      updater.markInProgress({
        id: "linear:eng-1",
        uuid: "u1",
        teamId: "",
        projectSlugId: "",
      }),
    ).rejects.toThrow(/has no workflow state with type=started/);
    expect(rawCalled).toBe(false);
  });
});
