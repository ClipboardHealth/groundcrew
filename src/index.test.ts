import * as packageRoot from "./index.ts";

// @ts-expect-error -- pull-request lookup results are intentionally not part of the package API.
import type { PullRequestSummary } from "./index.ts";

describe("package root", () => {
  it("keeps status snapshot implementation details private", () => {
    expect(packageRoot).not.toHaveProperty("STATUS_SNAPSHOT_SCHEMA_VERSION");
    expect(packageRoot).not.toHaveProperty("joinStatus");
    expect(packageRoot).not.toHaveProperty("readLocalSnapshot");
    expect(packageRoot).not.toHaveProperty("readRemoteSnapshot");
    expect(packageRoot).not.toHaveProperty("writeLocalSnapshot");
    expect(packageRoot).not.toHaveProperty("writeRemoteSnapshot");
    expect(packageRoot).not.toHaveProperty("collectStatus");
    expect(packageRoot).not.toHaveProperty("renderStatusText");
    expect(packageRoot).not.toHaveProperty("renderStatusJson");
  });

  it("keeps pull-request lookup result types private", () => {
    const internalTypeOnly = undefined as unknown as PullRequestSummary;

    expect(internalTypeOnly).toBeUndefined();
  });
});
