import type { LinearClient } from "@linear/sdk";

import { captureConsoleLog, type ConsoleCapture } from "../../../testHelpers/consoleCapture.ts";
import { createLinearIssueStatusUpdater } from "./writeback.ts";

interface ClientStub {
  team: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
}

interface StateNode {
  id: string;
  name: string;
  type: string;
  position: number;
}

function makeClient(
  options: { omitInProgressState?: boolean; states?: StateNode[] } = {},
): ClientStub {
  const { omitInProgressState = false, states } = options;
  const nodes =
    states ??
    (omitInProgressState
      ? [{ id: "state-other", name: "Other", type: "unstarted", position: 1 }]
      : [{ id: "state-in-progress", name: "In Progress", type: "started", position: 1 }]);
  return {
    team: vi
      .fn<() => Promise<{ states: () => Promise<{ nodes: StateNode[] }> }>>()
      .mockResolvedValue({
        states: vi.fn<() => Promise<{ nodes: StateNode[] }>>().mockResolvedValue({
          nodes,
        }),
      }),
    updateIssue: vi.fn<() => Promise<Record<string, never>>>().mockResolvedValue({}),
  };
}

function asLinearClient(stub: ClientStub): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by writeback
  return stub as unknown as LinearClient;
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

  it("markInReview targets the default 'In Review' state", async () => {
    const client = makeClient({
      states: [
        { id: "state-in-progress", name: "In Progress", type: "started", position: 1 },
        { id: "state-in-review", name: "In Review", type: "started", position: 2 },
      ],
    });
    const updater = createLinearIssueStatusUpdater({ client: asLinearClient(client) });

    await expect(
      updater.markInReview({ id: "team-1", uuid: "uuid-1", teamId: "shared" }),
    ).resolves.toStrictEqual({ outcome: "applied" });

    expect(client.updateIssue).toHaveBeenCalledWith("uuid-1", { stateId: "state-in-review" });
  });

  it("markInReview targets a configured review state name", async () => {
    const client = makeClient({
      states: [
        { id: "state-doing", name: "Doing", type: "started", position: 1 },
        { id: "state-code-review", name: "Code Review", type: "started", position: 2 },
      ],
    });
    const updater = createLinearIssueStatusUpdater({
      client: asLinearClient(client),
      statusNames: { inProgress: ["Doing"], inReview: ["Code Review"] },
    });

    await expect(
      updater.markInReview({ id: "team-1", uuid: "uuid-1", teamId: "shared" }),
    ).resolves.toStrictEqual({ outcome: "applied" });

    expect(client.updateIssue).toHaveBeenCalledWith("uuid-1", { stateId: "state-code-review" });
  });

  it("markInReview reports unsupported when no configured review state exists", async () => {
    const client = makeClient({
      states: [{ id: "state-in-progress", name: "In Progress", type: "started", position: 1 }],
    });
    const updater = createLinearIssueStatusUpdater({ client: asLinearClient(client) });

    await expect(
      updater.markInReview({ id: "team-1", uuid: "uuid-1", teamId: "shared" }),
    ).resolves.toStrictEqual({
      outcome: "unsupported",
      reason: 'Could not find a Linear workflow state named "In Review" for team shared',
    });

    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("markInReview reports unsupported without fetching states when teamId is missing", async () => {
    const client = makeClient();
    const updater = createLinearIssueStatusUpdater({ client: asLinearClient(client) });

    await expect(
      updater.markInReview({ id: "team-1", uuid: "uuid-1", teamId: "" }),
    ).resolves.toStrictEqual({
      outcome: "unsupported",
      reason: 'Could not find a Linear workflow state named "In Review" for team ?',
    });

    expect(client.team).not.toHaveBeenCalled();
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("caches the review state across multiple tickets in the same team", async () => {
    const client = makeClient({
      states: [
        { id: "state-in-progress", name: "In Progress", type: "started", position: 1 },
        { id: "state-in-review", name: "In Review", type: "started", position: 2 },
      ],
    });
    const updater = createLinearIssueStatusUpdater({ client: asLinearClient(client) });

    await updater.markInReview({ id: "team-1", uuid: "uuid-1", teamId: "shared" });
    await updater.markInReview({ id: "team-2", uuid: "uuid-2", teamId: "shared" });

    expect(client.team).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledTimes(2);
  });

  it("fetches the started-type state once across multiple tickets in the same team", async () => {
    const client = makeClient();
    const updater = createLinearIssueStatusUpdater({
      client: asLinearClient(client),
    });

    await updater.markInProgress({
      id: "team-1",
      uuid: "uuid-1",
      teamId: "shared",
    });
    await updater.markInProgress({
      id: "team-2",
      uuid: "uuid-2",
      teamId: "shared",
    });

    expect(client.team).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledTimes(2);
  });

  it("targets the 'In Progress' state even when 'In Review' (also started) is returned first", async () => {
    // Linear's default workflow has TWO started-type states: In Progress and
    // In Review. team.states() orders by updatedAt, not board position, so the
    // In Review state can come first — the old `.find(type === "started")`
    // parked tickets in In Review on launch.
    const client = makeClient({
      states: [
        { id: "state-in-review", name: "In Review", type: "started", position: 2 },
        { id: "state-in-progress", name: "In Progress", type: "started", position: 1 },
      ],
    });
    const updater = createLinearIssueStatusUpdater({ client: asLinearClient(client) });

    await updater.markInProgress({ id: "team-1", uuid: "uuid-1", teamId: "shared" });

    expect(client.updateIssue).toHaveBeenCalledWith("uuid-1", { stateId: "state-in-progress" });
  });

  it("falls back to the lowest-position started state when no state is named 'In Progress'", async () => {
    // Teams rename the in-progress column ("Doing", "WIP", ...). With no exact
    // name match, the leftmost (lowest-position) started column is In Progress.
    const client = makeClient({
      states: [
        { id: "state-code-review", name: "Code Review", type: "started", position: 3 },
        { id: "state-doing", name: "Doing", type: "started", position: 1 },
      ],
    });
    const updater = createLinearIssueStatusUpdater({ client: asLinearClient(client) });

    await updater.markInProgress({ id: "team-1", uuid: "uuid-1", teamId: "shared" });

    expect(client.updateIssue).toHaveBeenCalledWith("uuid-1", { stateId: "state-doing" });
  });

  it("re-fetches team workflow states on every failing markInProgress so an operator-side fix is picked up without restart", async () => {
    // No negative cache: a team missing its `started`-type workflow state is
    // a Linear-side config issue the operator can correct mid-session. The
    // previous design cached the failure and required a process restart to
    // recover; this test pins the re-fetch behavior.
    const client = makeClient({ omitInProgressState: true });
    const updater = createLinearIssueStatusUpdater({
      client: asLinearClient(client),
    });

    await expect(
      updater.markInProgress({
        id: "team-1",
        uuid: "uuid-1",
        teamId: "broken",
      }),
    ).rejects.toThrow('workflow state with type "started"');
    await expect(
      updater.markInProgress({
        id: "team-2",
        uuid: "uuid-2",
        teamId: "broken",
      }),
    ).rejects.toThrow('workflow state with type "started"');

    expect(client.team).toHaveBeenCalledTimes(2);
  });
});
