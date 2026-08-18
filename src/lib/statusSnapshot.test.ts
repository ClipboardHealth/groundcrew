import {
  buildRemoteDocument,
  type RemoteFetchResult,
  type RemoteStatusDocument,
  type RemoteStatusPayload,
  STATUS_SNAPSHOT_SCHEMA_VERSION,
} from "./statusSnapshot.ts";

function makePayload(capturedAt: string): RemoteStatusPayload {
  return {
    capturedAt,
    sourceByTask: {
      "eng-220": {
        id: "linear:eng-220",
        naturalId: "eng-220",
        title: "A task",
        status: "in-progress",
      },
    },
    inProgress: [],
    queueReady: [],
    queueBlocked: [],
  };
}

function errorResult(message: string): RemoteFetchResult {
  return {
    board: { kind: "error", message },
    pullRequestsByWorktree: {},
    pullRequestProblems: [],
    sourceProblems: [],
  };
}

function makeDocument(): RemoteStatusDocument {
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    lastAttemptAt: "2026-08-04T03:00:00.000Z",
    lastAttemptStatus: "ok",
    lastAttemptError: undefined,
    payload: makePayload("2026-08-04T03:00:00.000Z"),
    pullRequestsByWorktree: {},
  };
}

describe("buildRemoteDocument", () => {
  it("uses the current payload on a successful attempt", () => {
    const input = makePayload("2026-08-04T03:00:00.000Z");

    const actual = buildRemoteDocument({
      previous: undefined,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: {
        board: { kind: "ok", payload: input },
        pullRequestsByWorktree: {},
        pullRequestProblems: [],
        sourceProblems: [],
      },
    });

    expect(actual).toMatchObject({
      lastAttemptStatus: "ok",
      payload: input,
    });
  });

  it("keeps the previous payload when the attempt fails", () => {
    const actual = buildRemoteDocument({
      previous: makeDocument(),
      attemptAt: "2026-08-04T03:05:00.000Z",
      result: errorResult("Linear: 401 unauthorized"),
    });

    expect(actual).toMatchObject({
      lastAttemptAt: "2026-08-04T03:05:00.000Z",
      lastAttemptStatus: "unavailable",
      lastAttemptError: "Linear: 401 unauthorized",
      payload: { capturedAt: "2026-08-04T03:00:00.000Z" },
    });
  });

  it("leaves the payload undefined when the first attempt fails", () => {
    const actual = buildRemoteDocument({
      previous: undefined,
      attemptAt: "2026-08-04T03:05:00.000Z",
      result: errorResult("no api key"),
    });

    expect(actual.payload).toBeUndefined();
    expect(actual.lastAttemptStatus).toBe("unavailable");
  });
});
