/* oxlint-disable typescript/no-floating-promises, vitest/no-conditional-in-test, typescript/no-unsafe-type-assertion -- This is a node:test suite, not vitest: `describe`/`test` return promises the runner awaits (never floating), the conditionals live in the fake GraphQL server's route handlers (mock plumbing) rather than test control flow, and each `JSON.parse(...) as ProtocolResult` asserts a known wire shape (contracts §4.2) the type checker cannot verify. */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const BUNDLE = import.meta.dirname;
const API_KEY = "lin_api_test_key";

/** The union of GraphQL variable shapes this bundle sends (list/get/update). */
interface Variables {
  filter?: {
    assignee?: unknown;
    state?: { type?: { nin?: string[] } };
    labels?: unknown;
    and?: unknown;
  };
  after?: string | null;
  key?: string;
  number?: number;
  issueId?: string;
  body?: string;
  id?: string;
  stateId?: string;
}

interface Recorded {
  authorization: string | string[] | undefined;
  query: string;
  variables: Variables;
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
let apiUrl: string;
let requests: Recorded[];
// Route handler installed per test; returns the GraphQL `data` payload.
let respond: (recorded: Recorded) => unknown;

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query: string;
        variables: Variables;
      };
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
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  apiUrl = `http://127.0.0.1:${port}/graphql`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  requests = [];
  respond = () => ({});
});

// Async spawn (not spawnSync): these bundles call back into the in-process fake
// server over http, so the parent event loop must stay free to serve the child.
async function invoke(
  command: "list" | "get" | "update",
  input: unknown,
  extraEnv: Record<string, string> = {},
): Promise<ProtocolResult> {
  const child = spawn(process.execPath, [path.join(BUNDLE, command)], {
    // oxlint-disable-next-line node/no-process-env -- forward PATH/HOME to the child bundle process
    env: { ...process.env, LINEAR_API_KEY: API_KEY, LINEAR_API_URL: apiUrl, ...extraEnv },
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

/** Invoke and assert protocol success, returning the `data` payload. */
async function invokeOk(
  command: "list" | "get" | "update",
  input: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ tasks?: ProtocolTask[]; task?: ProtocolTask; result?: string; reason?: string }> {
  const response = await invoke(command, input, extraEnv);
  ok(response.ok, JSON.stringify(response));
  return response.data;
}

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uuid-1",
    identifier: "DEVOP-1",
    title: "Do the thing",
    description: "Some prose\nRepos: web, api\nAgent: claude",
    priority: 1,
    state: { type: "unstarted", name: "Todo" },
    labels: { nodes: [{ name: "agent-claude" }] },
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

describe("linear bundle", () => {
  test("list maps issues, sends auth, and filters non-terminal assigned issues", async () => {
    respond = () => ({
      issues: { nodes: [issueNode()], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const [task] = tasks;
    strictEqual(task?.id, "DEVOP-1");
    strictEqual(task?.title, "Do the thing");
    strictEqual(task?.priority, 4); // Urgent (Linear 1) → highest protocol number
    strictEqual(task?.terminal, false);
    deepStrictEqual(task?.repos, ["web", "api"]);
    strictEqual(task?.agent, "claude");

    const [recorded] = requests;
    strictEqual(recorded?.authorization, API_KEY);
    deepStrictEqual(recorded?.variables.filter?.assignee, { isMe: { eq: true } });
    // v1 parity: dispatch is opt-in via the agent-* label; backlog/triage never
    // surface, but terminal states DO (the reap sweep observes them).
    deepStrictEqual(recorded?.variables.filter?.labels, {
      some: { name: { startsWith: "agent-" } },
    });
    deepStrictEqual(recorded?.variables.filter?.state?.type?.nin?.toSorted(), [
      "backlog",
      "triage",
    ]);
  });

  test("the agent-* label is the routing and Todo-only gates dispatchability", async () => {
    respond = () => ({
      issues: {
        nodes: [
          issueNode({ identifier: "T-1" }), // unstarted + agent-claude
          issueNode({
            identifier: "T-2",
            state: { type: "started", name: "In Progress" },
            labels: { nodes: [{ name: "agent-codex" }] },
            description: "no directives here",
          }),
          issueNode({
            identifier: "T-3",
            state: { type: "completed", name: "Done" },
            description: "no directives here",
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    strictEqual(byId.get("T-1")?.agent, "claude"); // label wins over description
    strictEqual(byId.get("T-1")?.blocked, undefined); // unstarted ⇒ dispatchable
    strictEqual(byId.get("T-2")?.agent, "codex");
    strictEqual(byId.get("T-2")?.blocked, true); // started ⇒ listed, not dispatchable
    strictEqual(byId.get("T-3")?.terminal, true); // done ⇒ listed for the reap sweep
    strictEqual(byId.get("T-3")?.blocked, undefined);
  });

  test("a list larger than the 64KB pipe buffer arrives intact", async () => {
    // Regression: `process.exit` right after a large stdout write truncates at
    // the pipe buffer; found live with a 274KB real Linear list.
    const bigDescription = "x".repeat(10_000);
    respond = () => ({
      issues: {
        nodes: Array.from({ length: 30 }, (_, index) =>
          issueNode({ identifier: `BIG-${String(index)}`, description: bigDescription }),
        ),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const tasks = (await invokeOk("list", {})).tasks ?? [];
    strictEqual(tasks.length, 30);
    strictEqual(tasks[29]?.description?.length, 10_000);
  });

  test("priority inversion covers the whole scale", async () => {
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
    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    strictEqual(byId.get("P-1")?.priority, 4);
    strictEqual(byId.get("P-2")?.priority, 3);
    strictEqual(byId.get("P-3")?.priority, 2);
    strictEqual(byId.get("P-4")?.priority, 1);
    strictEqual("priority" in (byId.get("P-0") ?? {}), false); // None → omitted
  });

  test("open blocker marks the task blocked; terminal blocker does not", async () => {
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
              nodes: [
                { type: "blocks", issue: { identifier: "X-8", state: { type: "completed" } } },
              ],
            },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const tasks = (await invokeOk("list", {})).tasks ?? [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    strictEqual(byId.get("B-1")?.blocked, true);
    strictEqual("blocked" in (byId.get("B-2") ?? {}), false);
  });

  test("label filter is applied when LINEAR_GROUNDCREW_LABEL is set", async () => {
    respond = () => ({
      issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await invokeOk("list", {}, { LINEAR_GROUNDCREW_LABEL: "groundcrew" });
    deepStrictEqual(requests[0]?.variables.filter?.labels, {
      some: { name: { startsWith: "agent-" } },
    });
    deepStrictEqual(requests[0]?.variables.filter?.and, [
      { labels: { some: { name: { eq: "groundcrew" } } } },
    ]);
  });

  test("get resolves by identifier via team key + number", async () => {
    respond = (recorded) => {
      strictEqual(recorded.variables.key, "DEVOP");
      strictEqual(recorded.variables.number, 42);
      return { issues: { nodes: [issueNode({ identifier: "DEVOP-42" })] } };
    };
    const task = (await invokeOk("get", { id: "DEVOP-42" })).task;
    strictEqual(task?.id, "DEVOP-42");
  });

  test("get on a missing issue is a clean protocol failure", async () => {
    respond = () => ({ issues: { nodes: [] } });
    const response = await invoke("get", { id: "DEVOP-999" });
    strictEqual(response.ok, false);
    ok(!response.ok && response.error.message.includes("DEVOP-999"));
  });

  test("claimed posts a comment and returns ok (never rejected)", async () => {
    const bodies: string[] = [];
    respond = (recorded) => {
      if (recorded.query.includes("commentCreate")) {
        bodies.push(recorded.variables.body ?? "");
        return { commentCreate: { success: true } };
      }
      return { issues: { nodes: [issueNode()] } };
    };
    const data = await invokeOk("update", {
      id: "DEVOP-1",
      event: { type: "claimed", runId: "r_abc" },
    });
    deepStrictEqual(data, { result: "ok" });
    ok(bodies.some((body) => body.includes("claimed") && body.includes("r_abc")));
    // comment mutation carries the resolved issue uuid, not the identifier.
    const commentReq = requests.find((request) => request.query.includes("commentCreate"));
    strictEqual(commentReq?.variables.issueId, "uuid-1");
  });

  test("completed posts an outcome comment with artifacts", async () => {
    const bodies: string[] = [];
    respond = (recorded) => {
      if (recorded.query.includes("commentCreate")) {
        bodies.push(recorded.variables.body ?? "");
        return { commentCreate: { success: true } };
      }
      return { issues: { nodes: [issueNode()] } };
    };
    await invokeOk("update", {
      id: "DEVOP-1",
      event: {
        type: "completed",
        outcome: "delivered",
        message: "shipped",
        artifacts: [{ kind: "pr", locator: "https://x/pull/1", title: "Fix", repo: "web" }],
      },
    });
    const [body] = bodies;
    ok(body?.includes("delivered"));
    ok(body?.includes("shipped"));
    ok(body?.includes("https://x/pull/1"));
  });

  test("completed/delivered moves state when LINEAR_COMPLETED_STATE_ID is set", async () => {
    let moved: Variables | undefined;
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
    await invokeOk(
      "update",
      { id: "DEVOP-1", event: { type: "completed", outcome: "delivered", artifacts: [] } },
      { LINEAR_COMPLETED_STATE_ID: "state-done" },
    );
    deepStrictEqual(moved, { id: "uuid-1", stateId: "state-done" });
  });

  test("missing LINEAR_API_KEY is a clean protocol failure", () => {
    // No network call happens (config throws first), so spawnSync is safe here.
    const result = spawnSync(process.execPath, [path.join(BUNDLE, "list")], {
      input: "{}",
      // oxlint-disable-next-line node/no-process-env -- forward PATH/HOME to the child bundle process
      env: { ...process.env, LINEAR_API_KEY: "", LINEAR_API_URL: apiUrl },
      encoding: "utf8",
    });
    strictEqual(result.status, 0);
    const response = JSON.parse(result.stdout) as ProtocolResult;
    strictEqual(response.ok, false);
    ok(!response.ok && response.error.message.includes("LINEAR_API_KEY"));
  });

  // Optional, non-blocking: a real read-only probe against api.linear.app when
  // an ambient key is present. Never a test dependency — it only reports. It
  // hits the external API (not the in-process server), so spawnSync is safe.
  test("real Linear list probe (ambient key)", { skip: ambientKey() === "" }, () => {
    const result = spawnSync(process.execPath, [path.join(BUNDLE, "list")], {
      input: "{}",
      env: {
        // oxlint-disable-next-line node/no-process-env -- the real probe uses the ambient key/PATH
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
      const response = JSON.parse(result.stdout) as ProtocolResult;
      summary = response.ok
        ? `ok=true tasks=${response.data.tasks?.length ?? 0}`
        : `ok=false error=${response.error.message}`;
    } catch {
      summary = `no-parse (signal=${String(result.signal)}, status=${String(result.status)})`;
    }
    // Report only; never asserts on the network outcome.
    // eslint-disable-next-line no-console
    console.log(`[real-linear-probe] ${summary}`);
    ok(true);
  });
});

function ambientKey(): string {
  // Distinguish a real ambient key from the fake this suite injects.
  // oxlint-disable-next-line node/no-process-env -- ambient credential detection for the optional real probe
  const value = process.env["LINEAR_API_KEY"];
  return value !== undefined && value !== API_KEY ? value : "";
}
