import { joinStatus } from "./statusJoin.ts";
import {
  type LocalStatusDocument,
  type RemoteStatusDocument,
  STATUS_SNAPSHOT_SCHEMA_VERSION,
  type StatusTask,
} from "./statusSnapshot.ts";

function makeTask(task: string): StatusTask {
  return {
    task,
    title: undefined,
    url: undefined,
    agent: undefined,
    lifecycle: "running",
    flags: [],
    startedAt: undefined,
    updatedAt: undefined,
    resumeCount: undefined,
    reason: undefined,
    detail: undefined,
    session: "live",
    attachCommand: undefined,
    hint: undefined,
    worktrees: [
      {
        repository: "groundcrew",
        kind: "host",
        dir: "/work/eng-220",
        branch: "eng-220",
        git: { kind: "clean" },
      },
    ],
  };
}

function makeLocal(tasks: StatusTask[]): LocalStatusDocument {
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: "2026-08-04T03:16:00.000Z",
    maximumInProgress: 4,
    workspaceProbe: { status: "ok", error: undefined },
    tasks,
    orphanedSessions: [],
  };
}

function makeRemote(): RemoteStatusDocument {
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    lastAttemptAt: "2026-08-04T03:15:00.000Z",
    lastAttemptStatus: "ok",
    lastAttemptError: undefined,
    pullRequestsByWorktree: {
      "/work/eng-220": [{ url: "https://example.test/1", number: 1, state: "open", title: "PR" }],
    },
    payload: {
      capturedAt: "2026-08-04T03:15:00.000Z",
      sourceByTask: {
        "eng-220": {
          id: "linear:eng-220",
          naturalId: "eng-220",
          title: "A task",
          status: "in-progress",
        },
      },
      inProgress: [
        {
          id: "linear:eng-220",
          naturalId: "ENG-220",
          title: "a",
          url: undefined,
          repository: "groundcrew",
          agent: "opus",
        },
        {
          id: "linear:eng-217",
          naturalId: "ENG-217",
          title: "b",
          url: undefined,
          repository: "groundcrew",
          agent: "opus",
        },
      ],
      queueReady: [
        {
          id: "linear:eng-225",
          naturalId: "ENG-225",
          title: "c",
          url: undefined,
          repository: "groundcrew",
          agent: "opus",
        },
        {
          id: "linear:eng-220",
          naturalId: "ENG-220",
          title: "a",
          url: undefined,
          repository: "groundcrew",
          agent: "opus",
        },
      ],
      queueBlocked: [
        {
          id: "linear:eng-215",
          naturalId: "ENG-215",
          title: "d",
          url: undefined,
          repository: "groundcrew",
          agent: "opus",
          blockedBy: [
            {
              id: "linear:eng-201",
              naturalId: "eng-201",
              status: "in-progress",
              nativeStatus: undefined,
            },
          ],
        },
      ],
    },
  };
}

describe("joinStatus", () => {
  it("attaches board status and pull requests to each task", () => {
    const actual = joinStatus({ local: makeLocal([makeTask("eng-220")]), remote: makeRemote() });

    expect(actual.tasks[0]?.boardStatus).toBe("in-progress");
    expect(actual.tasks[0]?.worktrees[0]?.pullRequests).toHaveLength(1);
  });

  it("removes tasks with a local worktree from every board list", () => {
    const actual = joinStatus({ local: makeLocal([makeTask("eng-220")]), remote: makeRemote() });

    expect(actual.queueReady.map((issue) => issue.naturalId)).toEqual(["ENG-225"]);
    expect(actual.inProgressWithoutWorktree.map((issue) => issue.naturalId)).toEqual(["ENG-217"]);
  });

  it("counts every in-progress issue toward slots, including ones with worktrees", () => {
    const actual = joinStatus({ local: makeLocal([makeTask("eng-220")]), remote: makeRemote() });

    expect(actual.slots).toEqual({ used: 2, maximum: 4 });
  });

  it("subtracts against the local document even when the remote one is older", () => {
    const mockFresh = makeLocal([makeTask("eng-220"), makeTask("eng-225")]);

    const actual = joinStatus({ local: mockFresh, remote: makeRemote() });

    expect(actual.queueReady).toEqual([]);
  });

  it("keeps a blocked issue's blockers intact through the subtraction", () => {
    const actual = joinStatus({ local: makeLocal([]), remote: makeRemote() });

    expect(actual.queueBlocked[0]?.blockedBy).toEqual([
      {
        id: "linear:eng-201",
        naturalId: "eng-201",
        status: "in-progress",
        nativeStatus: undefined,
      },
    ]);
  });

  it("yields empty board lists and no slots when no fetch has ever succeeded", () => {
    const actual = joinStatus({
      local: makeLocal([makeTask("eng-220")]),
      remote: {
        schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
        lastAttemptAt: "2026-08-04T03:15:00.000Z",
        lastAttemptStatus: "unavailable",
        lastAttemptError: "no api key",
        payload: undefined,
        pullRequestsByWorktree: {},
      },
    });

    expect(actual.slots).toBeUndefined();
    expect(actual.queueReady).toEqual([]);
    expect(actual.tasks[0]?.boardStatus).toBeUndefined();
    expect(actual.tasks[0]?.worktrees[0]?.pullRequests).toEqual([]);
  });

  it("treats an absent remote document the same as an empty payload", () => {
    const actual = joinStatus({ local: makeLocal([makeTask("eng-220")]), remote: undefined });

    expect(actual.slots).toBeUndefined();
    expect(actual.inProgressWithoutWorktree).toEqual([]);
  });
});
