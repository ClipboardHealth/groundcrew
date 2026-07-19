import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const BUNDLE = import.meta.dirname;
const API_KEY = "lin_api_test_key";

interface Recorded {
  authorization?: string | string[];
  query: string;
  variables: any;
}

let server: Server;
let apiUrl: string;
let requests: Recorded[];
// Route handler installed per test; returns the GraphQL `data` payload.
let respond: (recorded: Recorded) => unknown;

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const recorded: Recorded = {
        authorization: request.headers.authorization,
        query: body.query,
        variables: body.variables,
      };
      requests.push(recorded);
      const data = respond(recorded);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  apiUrl = `http://127.0.0.1:${port}/graphql`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  requests = [];
  respond = () => ({});
});

function invoke(
  command: "list" | "get" | "update",
  input: unknown,
  extraEnv: Record<string, string> = {},
): any {
  const result = spawnSync(process.execPath, [join(BUNDLE, command)], {
    input: JSON.stringify(input),
    env: { ...process.env, LINEAR_API_KEY: API_KEY, LINEAR_API_URL: apiUrl, ...extraEnv },
    encoding: "utf8",
  });
  strictEqual(result.status, 0, `exit code for ${command}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uuid-1",
    identifier: "DEVOP-1",
    title: "Do the thing",
    description: "Some prose\nRepos: web, api\nAgent: claude",
    priority: 1,
    state: { type: "started", name: "In Progress" },
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

describe("linear bundle", () => {
  test("list maps issues, sends auth, and filters non-terminal assigned issues", () => {
    respond = () => ({
      issues: { nodes: [issueNode()], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    const response = invoke("list", {});
    ok(response.ok, JSON.stringify(response));
    const [task] = response.data.tasks;
    strictEqual(task.id, "DEVOP-1");
    strictEqual(task.title, "Do the thing");
    strictEqual(task.priority, 4); // Urgent (Linear 1) → highest protocol number
    strictEqual(task.terminal, false);
    deepStrictEqual(task.repos, ["web", "api"]);
    strictEqual(task.agent, "claude");

    const [recorded] = requests;
    strictEqual(recorded.authorization, API_KEY);
    deepStrictEqual(recorded.variables.filter.assignee, { isMe: { eq: true } });
    deepStrictEqual(recorded.variables.filter.state.type.nin.sort(), ["canceled", "completed"]);
  });

  test("priority inversion covers the whole scale", () => {
    respond = () => ({
      issues: {
        nodes: [
          issueNode({ identifier: "P-1", priority: 1 }),
          issueNode({ identifier: "P-2", priority: 2 }),
          issueNode({ identifier: "P-3", priority: 3 }),
          issueNode({ identifier: "P-4", priority: 4 }),
          issueNode({ identifier: "P-0", priority: 0 }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const tasks: any[] = invoke("list", {}).data.tasks;
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
    strictEqual(byId["P-1"].priority, 4);
    strictEqual(byId["P-2"].priority, 3);
    strictEqual(byId["P-3"].priority, 2);
    strictEqual(byId["P-4"].priority, 1);
    strictEqual("priority" in byId["P-0"], false); // None → omitted
  });

  test("open blocker marks the task blocked; terminal blocker does not", () => {
    respond = () => ({
      issues: {
        nodes: [
          issueNode({
            identifier: "B-1",
            inverseRelations: {
              nodes: [{ type: "blocks", issue: { identifier: "X-9", state: { type: "started" } } }],
            },
          }),
          issueNode({
            identifier: "B-2",
            inverseRelations: {
              nodes: [{ type: "blocks", issue: { identifier: "X-8", state: { type: "completed" } } }],
            },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const tasks: any[] = invoke("list", {}).data.tasks;
    strictEqual(tasks.find((task) => task.id === "B-1").blocked, true);
    strictEqual("blocked" in tasks.find((task) => task.id === "B-2"), false);
  });

  test("label filter is applied when LINEAR_GROUNDCREW_LABEL is set", () => {
    respond = () => ({
      issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    invoke("list", {}, { LINEAR_GROUNDCREW_LABEL: "groundcrew" });
    deepStrictEqual(requests[0].variables.filter.labels, { some: { name: { eq: "groundcrew" } } });
  });

  test("get resolves by identifier via team key + number", () => {
    respond = (recorded) => {
      strictEqual(recorded.variables.key, "DEVOP");
      strictEqual(recorded.variables.number, 42);
      return { issues: { nodes: [issueNode({ identifier: "DEVOP-42" })] } };
    };
    const response = invoke("get", { id: "DEVOP-42" });
    ok(response.ok);
    strictEqual(response.data.task.id, "DEVOP-42");
  });

  test("get on a missing issue is a clean protocol failure", () => {
    respond = () => ({ issues: { nodes: [] } });
    const response = invoke("get", { id: "DEVOP-999" });
    strictEqual(response.ok, false);
    ok(response.error.message.includes("DEVOP-999"));
  });

  test("claimed posts a comment and returns ok (never rejected)", () => {
    const bodies: string[] = [];
    respond = (recorded) => {
      if (recorded.query.includes("commentCreate")) {
        bodies.push(recorded.variables.body);
        return { commentCreate: { success: true } };
      }
      return { issues: { nodes: [issueNode()] } };
    };
    const response = invoke("update", { id: "DEVOP-1", event: { type: "claimed", runId: "r_abc" } });
    deepStrictEqual(response, { ok: true, data: { result: "ok" } });
    ok(bodies.some((body) => body.includes("claimed") && body.includes("r_abc")));
    // comment mutation carries the resolved issue uuid, not the identifier.
    const commentReq = requests.find((request) => request.query.includes("commentCreate"))!;
    strictEqual(commentReq.variables.issueId, "uuid-1");
  });

  test("completed posts an outcome comment with artifacts", () => {
    const bodies: string[] = [];
    respond = (recorded) => {
      if (recorded.query.includes("commentCreate")) {
        bodies.push(recorded.variables.body);
        return { commentCreate: { success: true } };
      }
      return { issues: { nodes: [issueNode()] } };
    };
    const response = invoke("update", {
      id: "DEVOP-1",
      event: {
        type: "completed",
        outcome: "delivered",
        message: "shipped",
        artifacts: [{ kind: "pr", locator: "https://x/pull/1", title: "Fix", repo: "web" }],
      },
    });
    ok(response.ok);
    const body = bodies[0];
    ok(body.includes("delivered"));
    ok(body.includes("shipped"));
    ok(body.includes("https://x/pull/1"));
  });

  test("completed/delivered moves state when LINEAR_COMPLETED_STATE_ID is set", () => {
    let moved: any;
    respond = (recorded) => {
      if (recorded.query.includes("commentCreate")) {
        return { commentCreate: { success: true } };
      }
      if (recorded.query.includes("issueUpdate")) {
        moved = recorded.variables;
        return { issueUpdate: { success: true } };
      }
      return { issues: { nodes: [issueNode()] } };
    };
    invoke(
      "update",
      { id: "DEVOP-1", event: { type: "completed", outcome: "delivered", artifacts: [] } },
      { LINEAR_COMPLETED_STATE_ID: "state-done" },
    );
    deepStrictEqual(moved, { id: "uuid-1", stateId: "state-done" });
  });

  test("missing LINEAR_API_KEY is a clean protocol failure", () => {
    const result = spawnSync(process.execPath, [join(BUNDLE, "list")], {
      input: "{}",
      env: { ...process.env, LINEAR_API_KEY: "", LINEAR_API_URL: apiUrl },
      encoding: "utf8",
    });
    strictEqual(result.status, 0);
    const response = JSON.parse(result.stdout);
    strictEqual(response.ok, false);
    ok(response.error.message.includes("LINEAR_API_KEY"));
  });

  // Optional, non-blocking: a real read-only probe against api.linear.app when
  // an ambient key is present. Never a test dependency — it only reports.
  test("real Linear list probe (ambient key)", { skip: !ambientKey() }, () => {
    const result = spawnSync(process.execPath, [join(BUNDLE, "list")], {
      input: "{}",
      env: {
        ...process.env,
        LINEAR_API_KEY: ambientKey(),
        LINEAR_API_URL: "",
        LINEAR_HTTP_TIMEOUT_MS: "8000",
      },
      encoding: "utf8",
      timeout: 12000, // hard cap: the probe can never wedge the suite
      killSignal: "SIGKILL",
    });
    let summary: string;
    try {
      const response = JSON.parse(result.stdout);
      summary = response.ok
        ? `ok=true tasks=${response.data.tasks.length}`
        : `ok=false error=${response.error.message}`;
    } catch {
      summary = `no-parse (killed=${result.killed}, status=${result.status})`;
    }
    // Report only; never asserts on the network outcome.
    // eslint-disable-next-line no-console
    console.log(`[real-linear-probe] ${summary}`);
    ok(true);
  });
});

function ambientKey(): string {
  // Distinguish a real ambient key from the fake this suite injects.
  const value = process.env["LINEAR_API_KEY"];
  return value && value !== API_KEY ? value : "";
}
