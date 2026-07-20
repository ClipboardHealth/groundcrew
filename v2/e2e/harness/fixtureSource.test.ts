import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "./exec.js";
import { installFixtureSource } from "./fixtureSource.js";
import type { FixtureSource } from "./fixtureSource.js";
import type { Scenario } from "./scenario.js";
import { withScenario } from "./scenario.js";
import {
  getDataSchema,
  listDataSchema,
  protocolResultSchema,
  updateDataSchema,
} from "./schemas.js";

async function invoke(input: {
  readonly scenario: Scenario;
  readonly source: FixtureSource;
  readonly command: "list" | "get" | "update";
  readonly stdin: Record<string, unknown>;
}): Promise<unknown> {
  const result = await run({
    command: path.join(input.source.bundleDirectory, input.command),
    env: { ...input.scenario.env, FIXTURE_STORE: input.source.storePath },
    input: JSON.stringify(input.stdin),
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

function expectOk<T>(
  result: { ok: true; data: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(`expected an ok protocol result but got error: ${result.error.message}`);
  }

  return result.data;
}

describe("fixture source", () => {
  it("round-trips list/get/update over stdin/stdout with result shapes", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      source.seed({
        tasks: [
          { id: "TASK-1", title: "First", priority: 2, repos: ["alpha"] },
          { id: "TASK-2", title: "Second" },
        ],
      });

      const list = expectOk(
        protocolResultSchema(listDataSchema).parse(
          await invoke({ scenario, source, command: "list", stdin: {} }),
        ),
      );
      expect(list.tasks.map((task) => task.id)).toEqual(["TASK-1", "TASK-2"]);

      const got = expectOk(
        protocolResultSchema(getDataSchema).parse(
          await invoke({ scenario, source, command: "get", stdin: { id: "TASK-1" } }),
        ),
      );
      expect(got.task.title).toBe("First");

      const updated = protocolResultSchema(updateDataSchema).parse(
        await invoke({
          scenario,
          source,
          command: "update",
          stdin: { id: "TASK-1", event: { type: "claimed", runId: "r_1" } },
        }),
      );
      expect(updated).toEqual({ ok: true, data: { result: "ok" } });
    });
  });

  it("journals every invocation with command, args, stdin and timestamp", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      source.seed({ tasks: [{ id: "TASK-1", title: "First" }] });

      await invoke({ scenario, source, command: "list", stdin: {} });
      await invoke({ scenario, source, command: "get", stdin: { id: "TASK-1" } });
      await invoke({
        scenario,
        source,
        command: "update",
        stdin: { id: "TASK-1", event: { type: "progress", note: "hi" } },
      });

      const calls = source.calls();
      expect(calls.map((call) => call.command)).toEqual(["list", "get", "update"]);
      expect(calls[1]?.stdin).toEqual({ id: "TASK-1" });
      for (const call of calls) {
        expect(typeof call.timestamp).toBe("string");
        expect(Array.isArray(call.args)).toBe(true);
      }
      expect(source.updateCalls()).toHaveLength(1);
    });
  });

  it("honors the rejectClaims knob", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      source.seed({ tasks: [{ id: "TASK-1", title: "First" }], rejectClaims: ["TASK-1"] });

      const result = protocolResultSchema(updateDataSchema).parse(
        await invoke({
          scenario,
          source,
          command: "update",
          stdin: { id: "TASK-1", event: { type: "claimed", runId: "r_1" } },
        }),
      );
      expect(result).toEqual({
        ok: true,
        data: { result: "rejected", reason: "fixture rejected claim" },
      });
    });
  });

  it("honors the failList knob", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      source.seed({ tasks: [], failList: true });

      const list = protocolResultSchema(listDataSchema).parse(
        await invoke({ scenario, source, command: "list", stdin: {} }),
      );
      expect(list.ok).toBe(false);
    });
  });

  it("records completion in the store and drops the task from list unless it recurs", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      source.seed({
        tasks: [
          { id: "TASK-1", title: "One" },
          { id: "TASK-2", title: "Two" },
        ],
        recurringTaskIds: ["TASK-2"],
      });

      for (const id of ["TASK-1", "TASK-2"]) {
        // oxlint-disable-next-line no-await-in-loop -- ordered writeback, one task at a time
        await invoke({
          scenario,
          source,
          command: "update",
          stdin: {
            id,
            event: {
              type: "completed",
              outcome: "delivered",
              artifacts: [{ kind: "pr", locator: `https://x/${id}` }],
            },
          },
        });
      }

      const store = source.readStore();
      expect(store.completions?.["TASK-1"]?.outcome).toBe("delivered");
      expect(store.completedTaskIds).toEqual(["TASK-1", "TASK-2"]);

      const list = expectOk(
        protocolResultSchema(listDataSchema).parse(
          await invoke({ scenario, source, command: "list", stdin: {} }),
        ),
      );
      expect(list.tasks.map((task) => task.id)).toEqual(["TASK-2"]);
    });
  });

  it("keeps terminal tasks in the list for the reaper", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      source.seed({ tasks: [{ id: "TASK-1", title: "Done", terminal: true }] });

      const list = expectOk(
        protocolResultSchema(listDataSchema).parse(
          await invoke({ scenario, source, command: "list", stdin: {} }),
        ),
      );
      expect(list.tasks[0]?.terminal).toBe(true);
    });
  });

  it("installs a read-only variant whose manifest omits update", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario, readOnly: true });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(source.bundleDirectory, "source.json"), "utf8"),
      ) as { commands: Record<string, string> };
      expect(manifest.commands["update"]).toBeUndefined();
      expect(manifest.commands["list"]).toBe("./list");
    });
  });

  it("bakes the store path into the installed manifest environment (init reachability)", async () => {
    await withScenario(async (scenario) => {
      const source = installFixtureSource({ scenario });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(source.bundleDirectory, "source.json"), "utf8"),
      ) as { environment: Record<string, string> };
      expect(manifest.environment["FIXTURE_STORE"]).toBe(source.storePath);
    });
  });
});
