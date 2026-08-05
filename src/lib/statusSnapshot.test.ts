import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "./config.ts";
import {
  buildRemoteDocument,
  readRemoteSnapshot,
  type RemoteStatusDocument,
  type RemoteStatusPayload,
  remoteSnapshotPath,
  STATUS_SNAPSHOT_SCHEMA_VERSION,
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
    pullRequestsByTask: {},
    inProgress: [],
    queueReady: [],
    queueBlocked: [],
  };
}

function makeDocument(overrides: Partial<RemoteStatusDocument> = {}): RemoteStatusDocument {
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    lastAttemptAt: "2026-08-04T03:00:00.000Z",
    lastAttemptStatus: "ok",
    lastAttemptError: undefined,
    payload: makePayload("2026-08-04T03:00:00.000Z"),
    ...overrides,
  };
}

describe("buildRemoteDocument", () => {
  it("replaces the payload on a successful attempt", () => {
    const input = makePayload("2026-08-04T03:00:00.000Z");

    const actual = buildRemoteDocument({
      previous: undefined,
      attemptAt: "2026-08-04T03:00:00.000Z",
      result: { kind: "ok", payload: input },
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
      result: { kind: "error", message: "Linear: 401 unauthorized" },
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
      result: { kind: "error", message: "no api key" },
    });

    expect(actual.payload).toBeUndefined();
    expect(actual.lastAttemptStatus).toBe("unavailable");
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
    const input = makeDocument();

    writeRemoteSnapshot({ config, document: input });
    const actual = readRemoteSnapshot(config);

    expect(actual).toEqual(input);
  });

  it("returns the document it wrote", () => {
    const config = makeConfig(directory);
    const input = makeDocument();

    const actual = writeRemoteSnapshot({ config, document: input });

    expect(actual).toEqual(input);
  });

  it("discards a write whose attempt is older than the file's", () => {
    const config = makeConfig(directory);
    const mockNewer = makeDocument({ lastAttemptAt: "2026-08-04T03:05:00.000Z" });
    writeRemoteSnapshot({ config, document: mockNewer });

    const actual = writeRemoteSnapshot({
      config,
      document: makeDocument({
        lastAttemptAt: "2026-08-04T03:00:00.000Z",
        lastAttemptStatus: "unavailable",
        lastAttemptError: "stale writer",
        payload: undefined,
      }),
    });

    expect(readRemoteSnapshot(config)).toEqual(mockNewer);
    expect(actual).toEqual(mockNewer);
  });

  it("accepts a write whose attempt matches the file's", () => {
    const config = makeConfig(directory);
    writeRemoteSnapshot({ config, document: makeDocument() });

    const actual = writeRemoteSnapshot({
      config,
      document: makeDocument({
        lastAttemptStatus: "unavailable",
        lastAttemptError: "source down",
      }),
    });

    expect(actual.lastAttemptStatus).toBe("unavailable");
    expect(readRemoteSnapshot(config)?.lastAttemptStatus).toBe("unavailable");
  });

  it("returns undefined for a missing file", () => {
    const config = makeConfig(directory);

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  it("returns undefined for an unparseable file", () => {
    const config = makeConfig(directory);
    writeRemoteSnapshot({ config, document: makeDocument() });
    writeFileSync(remoteSnapshotPath(config), "not json");

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  it("returns undefined for a document from an unknown schema version", () => {
    const config = makeConfig(directory);
    writeRemoteSnapshot({ config, document: makeDocument() });
    writeFileSync(
      remoteSnapshotPath(config),
      JSON.stringify({ ...makeDocument(), schemaVersion: 999 }),
    );

    expect(readRemoteSnapshot(config)).toBeUndefined();
  });

  it("leaves no temp file behind", () => {
    const config = makeConfig(directory);

    writeRemoteSnapshot({ config, document: makeDocument() });

    const actual = readFileSync(remoteSnapshotPath(config), "utf8");

    expect(JSON.parse(actual).schemaVersion).toBe(STATUS_SNAPSHOT_SCHEMA_VERSION);
  });
});
