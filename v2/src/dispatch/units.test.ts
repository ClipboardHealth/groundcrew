import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SourceHandle, WritebackEvent } from "../acquisition/index.js";
import { orderByPriority, resolveAgent } from "./routing.js";
import {
  dispatchStatePath,
  persistVerdicts,
  readDispatchState,
  upsertVerdict,
} from "./state.js";
import { SKIP_REASONS } from "./index.js";
import type { AgentRouting, DispatchSource, SourcedTask } from "./types.js";
import { createSourceWriteback, localIdOf } from "./writeback.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crew-units-"));
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

describe("skip reasons", () => {
  it("pins the four persisted verdict reasons (contracts §3.3)", () => {
    expect([...SKIP_REASONS]).toEqual([
      "repo-not-on-disk",
      "slots-full",
      "claim-rejected",
      "ineligible",
    ]);
  });
});

describe("dispatch state (dispatch.json)", () => {
  it("returns an empty map for an absent file", () => {
    const state = readDispatchState({ path: dispatchStatePath({ stateRoot }) });
    expect(state).toEqual({ version: 1, verdicts: {} });
  });

  it("persists and reads back the whole verdict map", () => {
    persistVerdicts({
      stateRoot,
      verdicts: { "fixture:TASK-1": { skipReason: "slots-full", ts: "2026-07-17T00:00:00.000Z" } },
    });
    const state = readDispatchState({ path: dispatchStatePath({ stateRoot }) });
    expect(state.verdicts["fixture:TASK-1"]?.skipReason).toBe("slots-full");
  });

  it("upserts and clears a single verdict", () => {
    upsertVerdict({
      stateRoot,
      taskId: "fixture:TASK-2",
      verdict: { skipReason: "claim-rejected", detail: "contended", ts: "2026-07-17T00:00:00.000Z" },
    });
    expect(
      readDispatchState({ path: dispatchStatePath({ stateRoot }) }).verdicts["fixture:TASK-2"]?.detail,
    ).toBe("contended");

    upsertVerdict({ stateRoot, taskId: "fixture:TASK-2", verdict: undefined });
    expect(
      readDispatchState({ path: dispatchStatePath({ stateRoot }) }).verdicts["fixture:TASK-2"],
    ).toBeUndefined();
  });

  it("treats a corrupt file as an empty map", () => {
    const filePath = dispatchStatePath({ stateRoot });
    fs.writeFileSync(filePath, "{ not json");
    expect(readDispatchState({ path: filePath }).verdicts).toEqual({});
  });
});

function sourceEntry(defaultAgent?: string): DispatchSource {
  return {
    handle: { name: "fixture" } as unknown as SourceHandle,
    ...(defaultAgent === undefined ? {} : { defaultAgent }),
  };
}

describe("routing", () => {
  const profiles = { scripted: { command: "true" }, special: { command: "true" } };
  const agents: AgentRouting = { default: "scripted", profiles };

  it("resolves task.agent over source and config defaults", () => {
    const resolved = resolveAgent({
      task: { agent: "special" },
      source: sourceEntry("scripted"),
      agents,
    });
    expect(resolved?.name).toBe("special");
  });

  it("falls back to the source default, then the config default", () => {
    expect(resolveAgent({ task: {}, source: sourceEntry("special"), agents })?.name).toBe("special");
    expect(resolveAgent({ task: {}, source: sourceEntry(), agents })?.name).toBe("scripted");
  });

  it("lets --agent override everything", () => {
    const resolved = resolveAgent({
      task: { agent: "scripted" },
      source: sourceEntry("scripted"),
      agents,
      override: "special",
    });
    expect(resolved?.name).toBe("special");
  });

  it("is undefined when nothing routes or the profile is unknown", () => {
    expect(resolveAgent({ task: {}, source: sourceEntry(), agents: { profiles } })).toBeUndefined();
    expect(
      resolveAgent({ task: { agent: "ghost" }, source: sourceEntry(), agents }),
    ).toBeUndefined();
  });

  it("orders by priority descending, stable within equal priority", () => {
    const source = sourceEntry();
    const tasks: SourcedTask[] = [
      { task: { id: "A", title: "a", priority: 1 }, source },
      { task: { id: "B", title: "b", priority: 5 }, source },
      { task: { id: "C", title: "c" }, source },
      { task: { id: "D", title: "d", priority: 5 }, source },
    ];
    expect(orderByPriority(tasks).map((entry) => entry.task.id)).toEqual(["B", "D", "A", "C"]);
  });
});

describe("writeback adapter", () => {
  it("extracts the source-local id from a canonical id", () => {
    expect(localIdOf({ taskId: "fixture:TASK-1", source: "fixture" })).toBe("TASK-1");
    // Colonful local ids survive (only the source prefix is stripped).
    expect(localIdOf({ taskId: "jira:PROJ:42", source: "jira" })).toBe("PROJ:42");
  });

  it("forwards a completion to the source update", async () => {
    const calls: Array<{ id: string; event: WritebackEvent }> = [];
    const handle = {
      name: "fixture",
      readOnly: false,
      async update(id: string, event: WritebackEvent) {
        calls.push({ id, event });
        return { result: "ok" as const };
      },
    } as unknown as SourceHandle;

    const port = createSourceWriteback({ source: handle, localId: "TASK-1" });
    await port.completed({
      outcome: "delivered",
      artifacts: [{ kind: "pr", locator: "https://x/1" }],
      message: "done",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toMatchObject({ type: "completed", outcome: "delivered", message: "done" });
  });

  it("no-ops for a read-only source", async () => {
    let called = false;
    const handle = {
      name: "fixture",
      readOnly: true,
      async update() {
        called = true;
        return { result: "ok" as const };
      },
    } as unknown as SourceHandle;

    const port = createSourceWriteback({ source: handle, localId: "TASK-1" });
    await port.completed({ outcome: "delivered", artifacts: [] });
    expect(called).toBe(false);
  });
});
