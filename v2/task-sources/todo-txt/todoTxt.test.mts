/* oxlint-disable typescript/no-floating-promises, vitest/no-conditional-in-test, typescript/no-unsafe-type-assertion -- This is a node:test suite, not vitest: `describe`/`test` return promises the runner awaits (never floating), the `??`/optional-chaining guards read optional fields of the typed protocol shape rather than branching test flow, and each `JSON.parse(...) as ProtocolResult` asserts a known wire shape (contracts §4.2) the type checker cannot verify. */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const BUNDLE = import.meta.dirname;

interface ProtocolTask {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  blocked?: boolean;
  agent?: string;
  repos?: string[];
  terminal: boolean;
}

type ProtocolResult =
  | {
      ok: true;
      data: { tasks?: ProtocolTask[]; task?: ProtocolTask; result?: string; reason?: string };
    }
  | { ok: false; error: { message: string } };

let workDir: string;
let todoFile: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "todo-txt-"));
  todoFile = path.join(workDir, "todo.txt");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// The bundle reads a local file (no network), so a synchronous spawn is safe.
function invoke(command: "list" | "get" | "update", input: unknown): ProtocolResult {
  const result = spawnSync(process.execPath, [path.join(BUNDLE, command)], {
    input: JSON.stringify(input),
    // oxlint-disable-next-line node/no-process-env -- forward PATH/HOME to the child bundle process
    env: { ...process.env, TODO_FILE: todoFile },
    encoding: "utf8",
  });
  strictEqual(result.status, 0, `exit code for ${command}: ${result.stderr}`);
  return JSON.parse(result.stdout) as ProtocolResult;
}

/** Invoke and assert protocol success, returning the `data` payload. */
function invokeOk(
  command: "list" | "get" | "update",
  input: unknown,
): { tasks?: ProtocolTask[]; task?: ProtocolTask; result?: string; reason?: string } {
  const response = invoke(command, input);
  ok(response.ok, JSON.stringify(response));
  return response.data;
}

function seed(lines: string[]): void {
  writeFileSync(todoFile, lines.join("\n") + "\n");
}

describe("todo-txt bundle", () => {
  test("v1's singular repo: tag is an accepted designation", () => {
    seed(["(B) Fix the widget repo:alpha agent:claude id:V1REPO"]);
    const tasks = invokeOk("list", {}).tasks ?? [];
    const task = tasks.find((entry) => entry.id === "V1REPO");
    deepStrictEqual(task?.repos, ["alpha"]);
  });

  test("list maps grammar to protocol tasks", () => {
    seed([
      "(A) Ship the login fix id:LOGIN-1 repos:web,api agent:claude",
      "(C) Write docs id:DOCS-2",
      "x 2026-07-18 Old done task id:OLD-9",
      "Investigate flaky test blocked:true id:FLAKE-3",
      "# a comment",
      "",
    ]);

    const tasks = invokeOk("list", {}).tasks ?? [];
    strictEqual(tasks.length, 4);
    const byId = new Map(tasks.map((task) => [task.id, task]));

    const login = byId.get("LOGIN-1");
    strictEqual(login?.title, "Ship the login fix");
    deepStrictEqual(login?.repos, ["web", "api"]);
    strictEqual(login?.agent, "claude");
    strictEqual(login?.terminal, false);

    const docs = byId.get("DOCS-2");
    // (A) must dispatch before (C): higher protocol number.
    ok((login?.priority ?? 0) > (docs?.priority ?? 0));
    strictEqual(login?.priority, 26);
    strictEqual(docs?.priority, 24);

    strictEqual(byId.get("OLD-9")?.terminal, true);
    strictEqual(byId.get("FLAKE-3")?.blocked, true);
  });

  test("id falls back to a stable content hash", () => {
    seed(["Buy milk", "Buy milk"]);
    const first = invokeOk("list", {}).tasks ?? [];
    const second = invokeOk("list", {}).tasks ?? [];
    // Identical lines hash to the same id; stable across calls.
    strictEqual(first[0]?.id, second[0]?.id);
    strictEqual(first[0]?.id, first[1]?.id);
    ok(/^[0-9a-f]{12}$/.test(first[0]?.id ?? ""));
  });

  test("get returns one task by id and errors on miss", () => {
    seed(["(B) Task one id:T-1"]);
    const hit = invokeOk("get", { id: "T-1" });
    strictEqual(hit.task?.id, "T-1");

    const miss = invoke("get", { id: "NOPE" });
    strictEqual(miss.ok, false);
    ok(!miss.ok && miss.error.message.includes("NOPE"));
  });

  test("update claimed acknowledges without mutating", () => {
    seed(["(A) Claim me id:C-1"]);
    const original = readFileSync(todoFile, "utf8");
    const data = invokeOk("update", { id: "C-1", event: { type: "claimed", runId: "r_1" } });
    deepStrictEqual(data, { result: "ok" });
    strictEqual(readFileSync(todoFile, "utf8"), original);
  });

  test("update completed/delivered marks the line done and moves priority to pri:", () => {
    seed(["(A) Finish me id:D-1 repos:web"]);
    invokeOk("update", {
      id: "D-1",
      event: { type: "completed", outcome: "delivered", artifacts: [], message: "done" },
    });

    const line = readFileSync(todoFile, "utf8").split("\n")[0] ?? "";
    ok(line.startsWith("x "), line);
    ok(/^x \d{4}-\d{2}-\d{2} /.test(line), line);
    ok(line.includes("pri:A"), line);
    ok(!/\([A-Z]\)/.test(line), "no bracketed priority remains");

    // The completed line now lists as terminal.
    strictEqual(invokeOk("get", { id: "D-1" }).task?.terminal, true);
  });

  test("update completed/failed leaves the line open and annotates it", () => {
    seed(["(B) Retry me id:F-1"]);
    invokeOk("update", {
      id: "F-1",
      event: { type: "completed", outcome: "failed", message: "boom went wrong" },
    });

    const line = readFileSync(todoFile, "utf8").split("\n")[0] ?? "";
    ok(!line.startsWith("x "), line);
    ok(line.includes("gc-outcome:failed"), line);
    ok(/gc-updated:\d{4}-\d{2}-\d{2}/.test(line), line);
    ok(line.includes("gc-note:boom_went_wrong"), line);

    strictEqual(invokeOk("get", { id: "F-1" }).task?.terminal, false);
  });

  test("missing TODO_FILE is a clean protocol failure", () => {
    const result = spawnSync(process.execPath, [path.join(BUNDLE, "list")], {
      input: "{}",
      // oxlint-disable-next-line node/no-process-env -- forward PATH/HOME to the child bundle process
      env: { ...process.env, TODO_FILE: "" },
      encoding: "utf8",
    });
    strictEqual(result.status, 0);
    const response = JSON.parse(result.stdout) as ProtocolResult;
    strictEqual(response.ok, false);
    ok(!response.ok && response.error.message.includes("TODO_FILE"));
  });
});
