import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "./config.ts";
import {
  buildRemoteDocument,
  type RemoteFetchResult,
  type LocalStatusDocument,
  localSnapshotPath,
  readLocalSnapshot,
  readRemoteSnapshot,
  type RemoteStatusDocument,
  type RemoteStatusPayload,
  remoteSnapshotPath,
  STATUS_SNAPSHOT_SCHEMA_VERSION,
  writeLocalSnapshot,
  writeRemoteSnapshot,
} from "./statusSnapshot.ts";

type LoggingConfig = Pick<ResolvedConfig, "logging">;

function makeConfig(directory: string): LoggingConfig {
  return { logging: { file: path.join(directory, "groundcrew.log") } };
}

function makePayload(capturedAt: string): RemoteStatusPayload {
  return {
    capturedAt,
    statusByTask: { "eng-220": "in-progress" },
    inProgress: [],
    queueReady: [],
    queueBlocked: [],
  };
}

function okResult(capturedAt: string): RemoteFetchResult {
  return {
    board: { kind: "ok", payload: makePayload(capturedAt) },
    pullRequestsByWorktree: {},
  };
}

function errorResult(message: string): RemoteFetchResult {
  return { board: { kind: "error", message }, pullRequestsByWorktree: {} };
}

function makeLocal(capturedAt: string): LocalStatusDocument {
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    maximumInProgress: 4,
    workspaceProbe: { status: "ok" },
    tasks: [],
    orphanedSessions: [],
  };
}

function makeDocument(overrides: Partial<RemoteStatusDocument> = {}): RemoteStatusDocument {
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    lastAttemptAt: "2026-08-04T03:00:00.000Z",
    lastAttemptStatus: "ok",
    lastAttemptError: undefined,
    payload: makePayload("2026-08-04T03:00:00.000Z"),
    pullRequestsByWorktree: {},
    ...overrides,
  };
}

describe("buildRemoteDocument", () => {
  it("replaces the payload on a successful attempt", () => {
    const input = makePayload("2026-08-04T03:00:00.000Z");

    const actual = buildRemoteDocument({
      previous: undefined,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: { board: { kind: "ok", payload: input }, pullRequestsByWorktree: {} },
    });

    expect(actual.lastAttemptStatus).toBe("ok");
    expect(actual.lastAttemptError).toBeUndefined();
    expect(actual.payload).toEqual(input);
  });

  it("keeps the previous payload when the attempt fails", () => {
    const mockPrevious = makeDocument();

    const actual = buildRemoteDocument({
      previous: mockPrevious,
      attemptAt: "2026-08-04T03:05:00.000Z",
      result: errorResult("Linear: 401 unauthorized"),
    });

    expect(actual.lastAttemptAt).toBe("2026-08-04T03:05:00.000Z");
    expect(actual.lastAttemptStatus).toBe("unavailable");
    expect(actual.lastAttemptError).toBe("Linear: 401 unauthorized");
    expect(actual.payload?.capturedAt).toBe("2026-08-04T03:00:00.000Z");
  });

  it("leaves the payload undefined when the first attempt ever fails", () => {
    const actual = buildRemoteDocument({
      previous: undefined,
      attemptAt: "2026-08-04T03:05:00.000Z",
      result: errorResult("no api key"),
    });

    expect(actual.payload).toBeUndefined();
    expect(actual.lastAttemptStatus).toBe("unavailable");
  });
});

describe("writeLocalSnapshot", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "gc-local-"));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("round-trips a document through disk", () => {
    const config = makeConfig(directory);
    const input = makeLocal("2026-08-04T03:00:00.000Z");

    const actual = writeLocalSnapshot({ config, document: input });

    expect(actual).toEqual(input);
    expect(readLocalSnapshot(config)).toEqual(input);
  });

  it("discards a write captured earlier than the file's", () => {
    const config = makeConfig(directory);
    const mockNewer = makeLocal("2026-08-04T03:05:00.000Z");
    writeLocalSnapshot({ config, document: mockNewer });

    const actual = writeLocalSnapshot({ config, document: makeLocal("2026-08-04T03:00:00.000Z") });

    expect(actual).toEqual(mockNewer);
    expect(readLocalSnapshot(config)).toEqual(mockNewer);
  });

  it("returns undefined for a document that is not a local snapshot", () => {
    const config = makeConfig(directory);
    writeFileSync(localSnapshotPath(config), JSON.stringify({ schemaVersion: 1 }));

    expect(readLocalSnapshot(config)).toBeUndefined();
  });
});

describe("writeRemoteSnapshot", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "gc-snapshot-"));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("round-trips a document through disk", () => {
    const config = makeConfig(directory);

    const actual = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: okResult("2026-08-04T03:00:00.000Z"),
    });

    expect(actual).toEqual(makeDocument());
    expect(readRemoteSnapshot(config)).toEqual(makeDocument());
  });

  // One read serves the merge and the guard, so a failure cannot reinstate a
  // payload that a concurrent success already replaced.
  it("merges against the file it guards on, not an earlier read", () => {
    const config = makeConfig(directory);
    writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:05:00.000Z",
      result: okResult("2026-08-04T03:05:00.000Z"),
    });

    const actual = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:06:00.000Z",
      result: errorResult("source down"),
    });

    expect(actual.lastAttemptStatus).toBe("unavailable");
    expect(actual.payload?.capturedAt).toBe("2026-08-04T03:05:00.000Z");
  });

  it("discards a write whose attempt is older than the file's", () => {
    const config = makeConfig(directory);
    const mockNewer = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:05:00.000Z",
      result: okResult("2026-08-04T03:05:00.000Z"),
    });

    const actual = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: errorResult("stale writer"),
    });

    expect(readRemoteSnapshot(config)).toEqual(mockNewer);
    expect(actual).toEqual(mockNewer);
  });

  it("accepts a write whose attempt matches the file's", () => {
    const config = makeConfig(directory);
    writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: okResult("2026-08-04T03:00:00.000Z"),
    });

    const actual = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: errorResult("source down"),
    });

    expect(actual.lastAttemptStatus).toBe("unavailable");
    expect(readRemoteSnapshot(config)?.lastAttemptStatus).toBe("unavailable");
  });

  // Without an upper bound, one future-dated file pins the snapshot forever.
  it("replaces a file dated in the future", () => {
    const config = makeConfig(directory);
    writeFileSync(
      remoteSnapshotPath(config),
      JSON.stringify(makeDocument({ lastAttemptAt: "2099-01-01T00:00:00.000Z" })),
    );

    const actual = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: okResult("2026-08-04T03:00:00.000Z"),
    });

    expect(actual.lastAttemptAt).toBe("2026-08-04T03:00:00.000Z");
  });

  it("replaces a file whose attempt timestamp is not ISO-8601", () => {
    const config = makeConfig(directory);
    writeFileSync(
      remoteSnapshotPath(config),
      JSON.stringify({ ...makeDocument(), lastAttemptAt: "not a timestamp" }),
    );

    const actual = writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: okResult("2026-08-04T03:00:00.000Z"),
    });

    expect(actual.lastAttemptAt).toBe("2026-08-04T03:00:00.000Z");
  });

  it("returns undefined for a missing file", () => {
    const config = makeConfig(directory);

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  it("returns undefined for an unparseable file", () => {
    const config = makeConfig(directory);
    writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: okResult("2026-08-04T03:00:00.000Z"),
    });
    writeFileSync(remoteSnapshotPath(config), "not json");

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  // A snapshot is a contract between two separately versioned programs, so
  // anything that does not match the shape is rejected rather than misread.
  it.each([
    ["a JSON null", "null"],
    ["a JSON scalar", "42"],
    ["a document with no attempt timestamp", JSON.stringify({ schemaVersion: 1 })],
    [
      "a document with an unknown attempt status",
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: "2026-08-04T03:00:00.000Z",
        lastAttemptStatus: "maybe",
      }),
    ],
    [
      "a document with no pull request record",
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: "2026-08-04T03:00:00.000Z",
        lastAttemptStatus: "ok",
      }),
    ],
    [
      "a document whose payload is not an object",
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: "2026-08-04T03:00:00.000Z",
        lastAttemptStatus: "ok",
        pullRequestsByWorktree: {},
        payload: "nope",
      }),
    ],
    [
      "a document whose payload lists are not arrays",
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: "2026-08-04T03:00:00.000Z",
        lastAttemptStatus: "ok",
        pullRequestsByWorktree: {},
        payload: {
          capturedAt: "2026-08-04T03:00:00.000Z",
          statusByTask: {},
          inProgress: "nope",
          queueReady: [],
          queueBlocked: [],
        },
      }),
    ],
  ])("returns undefined for %s", (_label, contents) => {
    const config = makeConfig(directory);
    writeFileSync(remoteSnapshotPath(config), contents);

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  it("returns undefined for a document from an unknown schema version", () => {
    const config = makeConfig(directory);
    writeFileSync(
      remoteSnapshotPath(config),
      JSON.stringify({ ...makeDocument(), schemaVersion: 999 }),
    );

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  it("leaves no temp file behind", () => {
    const config = makeConfig(directory);

    writeRemoteSnapshot({
      config,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: okResult("2026-08-04T03:00:00.000Z"),
    });

    const actual = readdirSync(directory);

    expect(actual).toEqual(["status-remote.json"]);
  });
});
