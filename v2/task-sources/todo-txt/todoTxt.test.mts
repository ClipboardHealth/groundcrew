import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const BUNDLE = import.meta.dirname;

let workDir: string;
let todoFile: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "todo-txt-"));
  todoFile = join(workDir, "todo.txt");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function invoke(command: "list" | "get" | "update", input: unknown): any {
  const result = spawnSync(process.execPath, [join(BUNDLE, command)], {
    input: JSON.stringify(input),
    env: { ...process.env, TODO_FILE: todoFile },
    encoding: "utf8",
  });
  strictEqual(result.status, 0, `exit code for ${command}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function seed(lines: string[]): void {
  writeFileSync(todoFile, lines.join("\n") + "\n");
}

describe("todo-txt bundle", () => {
  test("list maps grammar to protocol tasks", () => {
    seed([
      "(A) Ship the login fix id:LOGIN-1 repos:web,api agent:claude",
      "(C) Write docs id:DOCS-2",
      "x 2026-07-18 Old done task id:OLD-9",
      "Investigate flaky test blocked:true id:FLAKE-3",
      "# a comment",
      "",
    ]);

    const response = invoke("list", {});
    ok(response.ok, JSON.stringify(response));
    const tasks: any[] = response.data.tasks;
    strictEqual(tasks.length, 4);

    const login = tasks.find((task) => task.id === "LOGIN-1");
    strictEqual(login.title, "Ship the login fix");
    deepStrictEqual(login.repos, ["web", "api"]);
    strictEqual(login.agent, "claude");
    strictEqual(login.terminal, false);

    const docs = tasks.find((task) => task.id === "DOCS-2");
    // (A) must dispatch before (C): higher protocol number.
    ok(login.priority > docs.priority, `${login.priority} > ${docs.priority}`);
    strictEqual(login.priority, 26);
    strictEqual(docs.priority, 24);

    const old = tasks.find((task) => task.id === "OLD-9");
    strictEqual(old.terminal, true);

    const flaky = tasks.find((task) => task.id === "FLAKE-3");
    strictEqual(flaky.blocked, true);
  });

  test("id falls back to a stable content hash", () => {
    seed(["Buy milk", "Buy milk"]);
    const first = invoke("list", {}).data.tasks;
    const second = invoke("list", {}).data.tasks;
    // Identical lines hash to the same id; stable across calls.
    strictEqual(first[0].id, second[0].id);
    strictEqual(first[0].id, first[1].id);
    ok(/^[0-9a-f]{12}$/.test(first[0].id));
  });

  test("get returns one task by id and errors on miss", () => {
    seed(["(B) Task one id:T-1"]);
    const hit = invoke("get", { id: "T-1" });
    ok(hit.ok);
    strictEqual(hit.data.task.id, "T-1");

    const miss = invoke("get", { id: "NOPE" });
    strictEqual(miss.ok, false);
    ok(miss.error.message.includes("NOPE"));
  });

  test("update claimed acknowledges without mutating", () => {
    seed(["(A) Claim me id:C-1"]);
    const before = readFileSync(todoFile, "utf8");
    const response = invoke("update", { id: "C-1", event: { type: "claimed", runId: "r_1" } });
    deepStrictEqual(response, { ok: true, data: { result: "ok" } });
    strictEqual(readFileSync(todoFile, "utf8"), before);
  });

  test("update completed/delivered marks the line done and moves priority to pri:", () => {
    seed(["(A) Finish me id:D-1 repos:web"]);
    const response = invoke("update", {
      id: "D-1",
      event: { type: "completed", outcome: "delivered", artifacts: [], message: "done" },
    });
    ok(response.ok);

    const line = readFileSync(todoFile, "utf8").split("\n")[0];
    ok(line.startsWith("x "), line);
    ok(/^x \d{4}-\d{2}-\d{2} /.test(line), line);
    ok(line.includes("pri:A"), line);
    ok(!line.startsWith("x") || !/\([A-Z]\)/.test(line), "no bracketed priority remains");

    // The completed line now lists as terminal.
    const task = invoke("get", { id: "D-1" }).data.task;
    strictEqual(task.terminal, true);
  });

  test("update completed/failed leaves the line open and annotates it", () => {
    seed(["(B) Retry me id:F-1"]);
    const response = invoke("update", {
      id: "F-1",
      event: { type: "completed", outcome: "failed", message: "boom went wrong" },
    });
    ok(response.ok);

    const line = readFileSync(todoFile, "utf8").split("\n")[0];
    ok(!line.startsWith("x "), line);
    ok(line.includes("gc-outcome:failed"), line);
    ok(/gc-updated:\d{4}-\d{2}-\d{2}/.test(line), line);
    ok(line.includes("gc-note:boom_went_wrong"), line);

    const task = invoke("get", { id: "F-1" }).data.task;
    strictEqual(task.terminal, false);
  });

  test("missing TODO_FILE is a clean protocol failure", () => {
    const result = spawnSync(process.execPath, [join(BUNDLE, "list")], {
      input: "{}",
      env: { ...process.env, TODO_FILE: "" },
      encoding: "utf8",
    });
    strictEqual(result.status, 0);
    const response = JSON.parse(result.stdout);
    strictEqual(response.ok, false);
    ok(response.error.message.includes("TODO_FILE"));
  });
});
