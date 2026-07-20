/* oxlint-disable typescript/no-floating-promises, vitest/no-conditional-in-test, typescript/no-unsafe-type-assertion -- This is a node:test suite, not vitest: `describe`/`test` return promises the runner awaits (never floating), the conditionals live in the fake Jira server's route handlers (mock plumbing) rather than test control flow, and each `JSON.parse(...) as ProtocolResult` asserts a known wire shape (contracts §4.2) the type checker cannot verify. */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const BUNDLE = import.meta.dirname;
const EMAIL = "me@example.com";
const TOKEN = "tok_test_123";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
const DEFAULT_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created ASC";

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

interface RequestBody {
  jql?: string;
  maxResults?: number;
  fields?: string[];
  nextPageToken?: string;
  body?: AdfNode;
  transition?: { id?: string };
}

interface Recorded {
  method: string;
  url: string;
  authorization: string | string[] | undefined;
  body: RequestBody;
}

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

let server: Server;
let baseUrl: string;
let requests: Recorded[];
// Route handler installed per test; returns an HTTP status and optional JSON body.
let respond: (recorded: Recorded) => { status?: number; body?: unknown };

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: raw === "" ? {} : (JSON.parse(raw) as RequestBody),
      };
      requests.push(recorded);
      const { status = 200, body } = respond(recorded);
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  requests = [];
  respond = () => ({ body: {} });
});

// Async spawn (not spawnSync): the bundle calls back into the in-process fake
// server over http, so the parent event loop must stay free to serve the child.
async function invoke(
  command: "list" | "get" | "update",
  input: unknown,
  extraEnv: Record<string, string> = {},
): Promise<ProtocolResult> {
  const child = spawn(process.execPath, [path.join(BUNDLE, command)], {
    env: {
      // oxlint-disable-next-line node/no-process-env -- forward PATH/HOME to the child bundle process
      ...process.env,
      JIRA_EMAIL: EMAIL,
      JIRA_API_TOKEN: TOKEN,
      JIRA_BASE_URL: baseUrl,
      ...extraEnv,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.end(JSON.stringify(input));
  });
  strictEqual(code, 0, `exit code for ${command}: ${stderr}`);
  return JSON.parse(stdout) as ProtocolResult;
}

async function invokeOk(
  command: "list" | "get" | "update",
  input: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ tasks?: ProtocolTask[]; task?: ProtocolTask; result?: string; reason?: string }> {
  const response = await invoke(command, input, extraEnv);
  ok(response.ok, JSON.stringify(response));
  return response.data;
}

/** Build an Atlassian Document Format doc from plain lines (one paragraph each). */
function adfDoc(...lines: string[]): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  } as AdfNode;
}

/** Flatten an ADF node back to text, for asserting on comment bodies. */
function adfText(node: AdfNode | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.text ?? "";
  }
  const children = (node.content ?? []).map(adfText).join("");
  return node.type === "paragraph" ? `${children}\n` : children;
}

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fields = {
    summary: "Do the thing",
    description: adfDoc("Some prose", "Repos: web, api", "Agent: claude"),
    priority: { name: "High" },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuelinks: [],
    ...(overrides["fields"] as Record<string, unknown> | undefined),
  };
  return { key: "PROJ-1", ...overrides, fields };
}

function isSearch(recorded: Recorded): boolean {
  return recorded.method === "POST" && recorded.url === "/rest/api/3/search/jql";
}

/** An issuelink where this issue "is blocked by" a blocker in the given status category. */
function blockedBy(statusKey: string): Record<string, unknown> {
  return {
    type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    inwardIssue: { key: "X-9", fields: { status: { statusCategory: { key: statusKey } } } },
  };
}

describe("jira bundle", () => {
  test("list maps issues, sends Basic auth, and posts the JQL search", async () => {
    respond = () => ({ body: { issues: [issueNode()] } });

    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const [task] = tasks;
    strictEqual(task?.id, "PROJ-1");
    strictEqual(task?.title, "Do the thing");
    strictEqual(task?.priority, 4); // High → protocol 4
    strictEqual(task?.terminal, false);
    deepStrictEqual(task?.repos, ["web", "api"]);
    strictEqual(task?.agent, "claude");

    const [recorded] = requests;
    ok(recorded && isSearch(recorded));
    strictEqual(recorded?.authorization, EXPECTED_AUTH);
    strictEqual(recorded?.body.jql, DEFAULT_JQL);
    deepStrictEqual(recorded?.body.fields, [
      "summary",
      "description",
      "priority",
      "status",
      "issuelinks",
    ]);
  });

  test("priority names map across the scale; unknown is omitted", async () => {
    respond = () => ({
      body: {
        issues: [
          issueNode({ key: "P-1", fields: { priority: { name: "Highest" } } }),
          issueNode({ key: "P-2", fields: { priority: { name: "High" } } }),
          issueNode({ key: "P-3", fields: { priority: { name: "Medium" } } }),
          issueNode({ key: "P-4", fields: { priority: { name: "Low" } } }),
          issueNode({ key: "P-5", fields: { priority: { name: "Lowest" } } }),
          issueNode({ key: "P-0", fields: { priority: null } }),
        ],
      },
    });
    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    strictEqual(byId.get("P-1")?.priority, 5);
    strictEqual(byId.get("P-2")?.priority, 4);
    strictEqual(byId.get("P-3")?.priority, 3);
    strictEqual(byId.get("P-4")?.priority, 2);
    strictEqual(byId.get("P-5")?.priority, 1);
    strictEqual("priority" in (byId.get("P-0") ?? {}), false);
  });

  test("statusCategory done maps to terminal", async () => {
    respond = () => ({
      body: {
        issues: [
          issueNode({
            key: "T-1",
            fields: { status: { name: "Done", statusCategory: { key: "done" } } },
          }),
        ],
      },
    });
    const tasks = (await invokeOk("list", {})).tasks ?? [];
    strictEqual(tasks[0]?.terminal, true);
  });

  test("an open 'is blocked by' link marks the task blocked; a done blocker does not", async () => {
    respond = () => ({
      body: {
        issues: [
          issueNode({ key: "B-1", fields: { issuelinks: [blockedBy("indeterminate")] } }),
          issueNode({ key: "B-2", fields: { issuelinks: [blockedBy("done")] } }),
        ],
      },
    });
    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    strictEqual(byId.get("B-1")?.blocked, true);
    strictEqual("blocked" in (byId.get("B-2") ?? {}), false);
  });

  test("JIRA_GROUNDCREW_JQL overrides the query", async () => {
    respond = () => ({ body: { issues: [] } });
    await invokeOk("list", {}, { JIRA_GROUNDCREW_JQL: "project = OPS ORDER BY created" });
    strictEqual(requests[0]?.body.jql, "project = OPS ORDER BY created");
  });

  test("list follows nextPageToken across pages", async () => {
    respond = (recorded) => {
      if (recorded.body.nextPageToken === "page-2") {
        return { body: { issues: [issueNode({ key: "PAGE-2" })] } };
      }
      return { body: { issues: [issueNode({ key: "PAGE-1" })], nextPageToken: "page-2" } };
    };
    const tasks = (await invokeOk("list", {})).tasks ?? [];
    deepStrictEqual(
      tasks.map((task) => task.id),
      ["PAGE-1", "PAGE-2"],
    );
    strictEqual(requests.length, 2);
  });

  test("get resolves a single issue by key", async () => {
    respond = (recorded) => {
      strictEqual(recorded.method, "GET");
      ok(recorded.url.startsWith("/rest/api/3/issue/PROJ-42"));
      return { body: issueNode({ key: "PROJ-42" }) };
    };
    const task = (await invokeOk("get", { id: "PROJ-42" })).task;
    strictEqual(task?.id, "PROJ-42");
  });

  test("get on a missing issue is a clean protocol failure", async () => {
    respond = () => ({ status: 404, body: { errorMessages: ["Issue does not exist"] } });
    const response = await invoke("get", { id: "PROJ-999" });
    strictEqual(response.ok, false);
    ok(!response.ok && response.error.message.includes("PROJ-999"));
  });

  test("claimed posts an ADF comment and returns ok", async () => {
    respond = () => ({ status: 201, body: { id: "10000" } });
    const data = await invokeOk("update", {
      id: "PROJ-1",
      event: { type: "claimed", runId: "r_abc" },
    });
    deepStrictEqual(data, { result: "ok" });

    const [recorded] = requests;
    strictEqual(recorded?.method, "POST");
    strictEqual(recorded?.url, "/rest/api/3/issue/PROJ-1/comment");
    strictEqual(recorded?.authorization, EXPECTED_AUTH);
    const text = adfText(recorded?.body.body);
    ok(text.includes("claimed"));
    ok(text.includes("r_abc"));
  });

  test("completed posts an outcome comment with artifacts", async () => {
    respond = () => ({ status: 201, body: { id: "10001" } });
    await invokeOk("update", {
      id: "PROJ-1",
      event: {
        type: "completed",
        outcome: "delivered",
        message: "shipped",
        artifacts: [{ kind: "pr", locator: "https://x/pull/1", title: "Fix", repo: "web" }],
      },
    });
    const text = adfText(requests[0]?.body.body);
    ok(text.includes("delivered"));
    ok(text.includes("shipped"));
    ok(text.includes("https://x/pull/1"));
  });

  test("completed/delivered transitions when JIRA_DONE_TRANSITION_ID is set", async () => {
    respond = (recorded) => {
      if (recorded.url.endsWith("/transitions")) {
        return { status: 204 };
      }
      return { status: 201, body: { id: "10002" } };
    };
    await invokeOk(
      "update",
      { id: "PROJ-1", event: { type: "completed", outcome: "delivered", artifacts: [] } },
      { JIRA_DONE_TRANSITION_ID: "31" },
    );
    const transitionReq = requests.find((request) => request.url.endsWith("/transitions"));
    strictEqual(transitionReq?.url, "/rest/api/3/issue/PROJ-1/transitions");
    deepStrictEqual(transitionReq?.body.transition, { id: "31" });
  });

  test("a missing required secret is a clean protocol failure", () => {
    // config() throws before any network call, so spawnSync is safe here.
    for (const missing of ["JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_BASE_URL"]) {
      const env: Record<string, string> = {
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
        JIRA_BASE_URL: baseUrl,
        [missing]: "",
      };
      const result = spawnSync(process.execPath, [path.join(BUNDLE, "list")], {
        input: "{}",
        // oxlint-disable-next-line node/no-process-env -- forward PATH/HOME to the child bundle process
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
      strictEqual(result.status, 0);
      const response = JSON.parse(result.stdout) as ProtocolResult;
      strictEqual(response.ok, false, `${missing} should fail`);
      ok(!response.ok && response.error.message.includes(missing));
    }
  });
});
