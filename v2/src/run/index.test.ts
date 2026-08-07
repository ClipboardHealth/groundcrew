import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "./index.js";

describe("RunStore", () => {
  it("creates one durable run when initial writers race", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-race-"));
    const store = new RunStore({ stateRoot });

    const results = await Promise.allSettled(
      Array.from(
        { length: 20 },
        async () =>
          await store.create({
            agentProfile: "codex",
            canonicalTaskId: "fixture:ENG-123",
            repositories: [],
            workspaceDirectory: join(stateRoot, "workspace"),
          }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect({ fulfilled: fulfilled.length, rejected: rejected.length }).toEqual({
      fulfilled: 1,
      rejected: 19,
    });
    const stored = await store.get({ canonicalTaskId: "fixture:ENG-123" });
    expect(stored?.runId).toBe(fulfilled[0]?.value.runId);
  });
});
