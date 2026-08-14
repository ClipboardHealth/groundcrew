import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

describe("the shipped Linear source", () => {
  let fixture: Awaited<ReturnType<typeof createLinearFixture>>;

  beforeEach(async () => {
    fixture = await createLinearFixture();
  });

  afterEach(async () => {
    await fixture.close();
    await Promise.all(
      fixtureRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
    );
  });

  it("uses portable CA stores when the runtime build default cannot validate Linear", async () => {
    const shimDirectory = await mkdtemp(join(tmpdir(), "groundcrew-v2-linear-node-shim-"));
    fixtureRoots.push(shimDirectory);
    const shimInvocationPath = join(shimDirectory, "invocation");
    await writeFile(
      join(shimDirectory, "node"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" > "$NODE_SHIM_INVOCATION_PATH"',
        'case " $* " in *" --use-bundled-ca "*) ;; *) printf \'%s\\n\' \'{"ok":false,"error":{"message":"bundled CA store not enabled"}}\'; exit 0 ;; esac',
        'case " $* " in *" --use-system-ca "*) ;; *) printf \'%s\\n\' \'{"ok":false,"error":{"message":"system CA store not enabled"}}\'; exit 0 ;; esac',
        'exec "$REAL_NODE_PATH" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const doctor = await runCrew({
      arguments: ["doctor"],
      environment: {
        ...fixture.environment,
        PATH: `${shimDirectory}:${fixture.environment["PATH"]}`,
        REAL_NODE_PATH: process.execPath,
        NODE_SHIM_INVOCATION_PATH: shimInvocationPath,
      },
    });

    expect(doctor.stdout).toContain("live list probe: healthy (1 tasks)");
    const shimInvocation = await readFile(shimInvocationPath, "utf8");
    expect(shimInvocation).toContain("--use-bundled-ca");
    expect(shimInvocation).toContain("--use-system-ca");
  });

  it("reports the underlying network cause when Linear cannot be reached", async () => {
    const refusalPort = await closedLoopbackPort();
    const result = await runLinearList({
      environment: {
        ...fixture.environment,
        LINEAR_API_URL: `http://127.0.0.1:${refusalPort}/graphql`,
      },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      error: { message: expect.stringContaining("ECONNREFUSED") },
      ok: false,
    });
  });

  it("probes, claims, comments, moves, and completes through the process protocol", async () => {
    const doctor = await runCrew({ arguments: ["doctor"], environment: fixture.environment });
    expect(doctor.stdout).toContain("linear (package, protocol 1)");
    expect(doctor.stdout).toContain("live list probe: healthy (1 tasks)");

    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });
    await runCrew({
      arguments: [
        "artifact",
        "add",
        "https://example.test/pr/1",
        "--kind",
        "pr",
        "--task",
        "LIN-1",
      ],
      environment: fixture.environment,
    });
    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });

    expect(fixture.state.stateName).toBe("In Review");
    expect(fixture.state.comments).toHaveLength(2);
    expect(fixture.state.comments[0]).toContain("Claimed by Groundcrew");
    expect(fixture.state.comments[1]).toContain("https://example.test/pr/1");
  });

  it("returns a failed run to Todo", async () => {
    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });

    await runCrew({
      arguments: ["done", "--outcome", "failed", "--task", "LIN-1"],
      environment: fixture.environment,
    });

    expect(fixture.state.stateName).toBe("Todo");
    expect(fixture.state.stateType).toBe("unstarted");
    expect(fixture.state.comments.at(-1)).toContain(":completed:failed]");
  });

  it("preserves a terminal issue when delivered completion writeback settles", async () => {
    fixture.state.stateName = "Done";
    fixture.state.stateType = "completed";

    const result = await runLinearUpdate({
      environment: fixture.environment,
      payload: {
        event: {
          artifacts: [],
          message: "Delivered after the issue reached Done.",
          outcome: "delivered",
          runId: "r_00112233",
          type: "completed",
        },
        id: "LIN-1",
      },
    });

    expect(JSON.parse(result.stdout)).toEqual({ data: { result: "ok" }, ok: true });
    expect(fixture.state.moveRequests).toEqual([]);
    expect(fixture.state.stateName).toBe("Done");
    expect(fixture.state.stateType).toBe("completed");
    expect(fixture.state.comments.at(-1)).toContain("[groundcrew:r_00112233:completed:delivered]");
  });

  it("leaves a delivered run unchanged when In Review is unavailable", async () => {
    await fixture.close();
    fixture = await createLinearFixture({ includeInReviewState: false });
    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });
    expect(fixture.state.stateName).toBe("In Progress");
    fixture.state.moveRequests.length = 0;

    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });

    expect(fixture.state.stateName).toBe("In Progress");
    expect(fixture.state.moveRequests).toEqual([]);
    expect(fixture.state.comments.at(-1)).toContain(":completed:delivered]");
  });

  it("stamps a completion with its own run ID despite a newer claim comment", async () => {
    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });
    const claimRunId = fixture.state.comments[0]?.match(
      /\[groundcrew:(r_[0-9a-f]{8}):claimed\]/,
    )?.[1];
    fixture.state.comments.push("[groundcrew:r_deadbeef:claimed]\nClaimed by Groundcrew.");

    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });

    expect(claimRunId).toBeDefined();
    expect(fixture.state.comments.at(-1)).toContain(
      `[groundcrew:${claimRunId}:completed:delivered]`,
    );
  });

  it("continues a delivered run from In Review and completes under the new run ID", async () => {
    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });
    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });
    expect(fixture.state.stateName).toBe("In Review");

    await runCrew({ arguments: ["continue", "LIN-1"], environment: fixture.environment });

    expect(fixture.state.stateName).toBe("In Progress");
    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });
    expect(fixture.state.stateName).toBe("In Review");
    const claimRunIds = fixture.state.comments.flatMap(
      (comment) => comment.match(/\[groundcrew:(r_[0-9a-f]{8}):claimed\]/)?.slice(1) ?? [],
    );
    const completionRunIds = fixture.state.comments.flatMap(
      (comment) =>
        comment.match(/\[groundcrew:(r_[0-9a-f]{8}):completed:delivered\]/)?.slice(1) ?? [],
    );
    expect(claimRunIds).toHaveLength(2);
    expect(completionRunIds).toEqual(claimRunIds);
  });

  it("continues an In Review issue with a fresh claim marker", async () => {
    fixture.state.stateName = "In Review";
    fixture.state.stateType = "started";
    fixture.state.comments.push("[groundcrew:r_00112233:claimed]\nClaimed by Groundcrew.");

    const result = await runLinearUpdate({
      environment: fixture.environment,
      payload: {
        event: { previousRunId: "r_00112233", runId: "r_44556677", type: "continued" },
        id: "LIN-1",
      },
    });

    expect(JSON.parse(result.stdout)).toEqual({ data: { result: "ok" }, ok: true });
    expect(fixture.state.comments.at(-1)).toContain("[groundcrew:r_44556677:claimed]");
    expect(fixture.state.comments.at(-1)).toContain("r_00112233");
    expect(fixture.state.stateName).toBe("In Progress");
  });

  it("rejects continuing a terminal issue", async () => {
    fixture.state.stateName = "Done";
    fixture.state.stateType = "completed";

    const result = await runLinearUpdate({
      environment: fixture.environment,
      payload: {
        event: { previousRunId: "r_00112233", runId: "r_44556677", type: "continued" },
        id: "LIN-1",
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { result: "rejected" },
      ok: true,
    });
    expect(fixture.state.comments).toHaveLength(0);
    expect(fixture.state.stateName).toBe("Done");
  });

  it("paginates list queries beneath Linear's complexity limit", async () => {
    await fixture.close();
    fixture = await createLinearFixture({ listedTaskCount: 251 });

    const doctor = await runCrew({ arguments: ["doctor"], environment: fixture.environment });

    expect(doctor.stdout).toContain("live list probe: healthy (251 tasks)");
  });

  it("filters list queries before paginating while retaining actionable and terminal tasks", async () => {
    await fixture.close();
    fixture = await createLinearFixture({ filteringScenario: true, labelPrefix: "crew-" });

    const result = await runLinearList({ environment: fixture.environment });
    const response = JSON.parse(result.stdout);

    expect(response.error).toBeUndefined();
    expect(response.data.tasks).toEqual([
      expect.objectContaining({ id: "LIN-ELIGIBLE", terminal: false }),
      expect.objectContaining({ id: "LIN-COMPLETED", terminal: true }),
    ]);
    expect(fixture.state.listRequests).toHaveLength(1);
    const request = fixture.state.listRequests[0];
    expect(request?.query).toContain("assignee: { isMe: { eq: true } }");
    expect(request?.query).toContain(
      "labels: { some: { name: { startsWith: $agentLabelPrefix } } }",
    );
    expect(request?.query).toContain("state: { type: { in: $stateTypes } }");
    expect(request?.query).toContain("first: 250");
    expect(request?.query).toContain("includeArchived: false");
    expect(request?.variables).toMatchObject({
      agentLabelPrefix: "crew-",
      stateTypes: ["unstarted", "started", "completed", "canceled", "duplicate"],
    });
  });

  it("recognizes a singular Repository header", async () => {
    await fixture.close();
    fixture = await createLinearFixture({ issueDescription: "Repository: missing" });

    await expect(
      runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("writes completion artifacts again after cleanup and redispatch", async () => {
    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });
    await runCrew({
      arguments: ["artifact", "add", "first-output", "--task", "LIN-1"],
      environment: fixture.environment,
    });
    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });
    await runCrew({ arguments: ["cleanup", "LIN-1"], environment: fixture.environment });

    fixture.state.stateName = "Todo";
    fixture.state.stateType = "unstarted";
    await runCrew({ arguments: ["start", "LIN-1"], environment: fixture.environment });
    await runCrew({
      arguments: ["artifact", "add", "second-output", "--task", "LIN-1"],
      environment: fixture.environment,
    });
    await runCrew({ arguments: ["done", "--task", "LIN-1"], environment: fixture.environment });

    expect(
      fixture.state.comments.filter((comment) => comment.includes(":completed:delivered]")),
    ).toHaveLength(2);
    const claimRunIds = fixture.state.comments.flatMap(
      (comment) => comment.match(/\[groundcrew:(r_[0-9a-f]{8}):claimed\]/)?.slice(1) ?? [],
    );
    const latestCompletion = fixture.state.comments.findLast((comment) =>
      comment.includes(":completed:delivered]"),
    );
    expect(latestCompletion).toContain(`[groundcrew:${claimRunIds.at(-1)}:completed:delivered]`);
    expect(fixture.state.comments.some((comment) => comment.includes("first-output"))).toBe(true);
    expect(fixture.state.comments.some((comment) => comment.includes("second-output"))).toBe(true);
  });
});

interface LinearState {
  comments: string[];
  listRequests: Array<{ query: string; variables: Record<string, unknown> }>;
  moveRequests: string[];
  stateName: string;
  stateType: string;
}

async function createLinearFixture(
  input: {
    readonly filteringScenario?: boolean;
    readonly includeInReviewState?: boolean;
    readonly issueDescription?: string;
    readonly labelPrefix?: string;
    readonly listedTaskCount?: number;
  } = {},
): Promise<{
  readonly close: () => Promise<void>;
  readonly environment: NodeJS.ProcessEnv;
  readonly state: LinearState;
}> {
  const listedTaskCount = input.listedTaskCount ?? 1;
  const state: LinearState = {
    comments: [],
    listRequests: [],
    moveRequests: [],
    stateName: "Todo",
    stateType: "unstarted",
  };
  const labelPrefix = input.labelPrefix ?? "agent-";
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
      }
      const body = JSON.parse(raw);
      const issue = linearIssue({
        description: input.issueDescription,
        includeInReviewState: input.includeInReviewState,
        state,
      });
      let data;
      if (body.operationName === "GroundcrewList") {
        state.listRequests.push({ query: body.query, variables: body.variables });
        const listedIssues = input.filteringScenario
          ? filteringScenarioIssues({
              includeInReviewState: input.includeInReviewState,
              labelPrefix,
              state,
            })
          : Array.from({ length: listedTaskCount }, (_, index) =>
              linearIssue({
                description: input.issueDescription,
                identifier: `LIN-${index + 1}`,
                includeInReviewState: input.includeInReviewState,
                state,
              }),
            );
        const usesServerFilters = body.query.includes("issues(");
        const stateTypes = Array.isArray(body.variables.stateTypes)
          ? body.variables.stateTypes
          : [];
        const requestedLabelPrefix = body.variables.agentLabelPrefix;
        const candidateIssues = usesServerFilters
          ? listedIssues.filter(
              (listedIssue) =>
                stateTypes.includes(listedIssue.state.type) &&
                listedIssue.labels.nodes.some((label) =>
                  label.name.startsWith(requestedLabelPrefix),
                ),
            )
          : listedIssues;
        const pageSize = body.query.includes("first: 250") ? 250 : 20;
        const pageStart = body.variables.after === undefined ? 0 : Number(body.variables.after);
        const pageEnd = Math.min(pageStart + pageSize, candidateIssues.length);
        const page = {
          nodes: candidateIssues.slice(pageStart, pageEnd),
          pageInfo: {
            endCursor: pageEnd < candidateIssues.length ? String(pageEnd) : undefined,
            hasNextPage: pageEnd < candidateIssues.length,
          },
        };
        data = usesServerFilters ? { issues: page } : { viewer: { assignedIssues: page } };
      } else if (body.operationName === "GroundcrewIssue") {
        data = { issue };
      } else if (body.operationName === "GroundcrewComment") {
        state.comments.push(body.variables.input.body);
        data = { commentCreate: { success: true } };
      } else if (body.operationName === "GroundcrewMove") {
        const stateId = body.variables.input.stateId;
        state.moveRequests.push(stateId);
        state.stateName =
          stateId === "state-review"
            ? "In Review"
            : stateId === "state-todo"
              ? "Todo"
              : "In Progress";
        state.stateType = stateId === "state-todo" ? "unstarted" : "started";
        data = { issueUpdate: { success: true } };
      } else {
        response.statusCode = 400;
        data = {};
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data }));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
        }),
      );
    }
  });
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind TCP");
  }
  const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-linear-"));
  fixtureRoots.push(root);
  const configPath = join(root, "crew.config.jsonc");
  const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
  await Promise.all([
    writeFile(join(root, "cmux-state.json"), '{"workspaces":[]}'),
    writeFile(join(root, "cmux-calls.jsonl"), ""),
    writeFile(
      configPath,
      JSON.stringify({
        agents: { default: "codex", profiles: { codex: { kind: "codex" } } },
        sources: [
          {
            environment: { LINEAR_API_URL: `http://127.0.0.1:${address.port}/graphql` },
            kind: "linear",
          },
        ],
        workspace: { baseDirectory: join(root, "dev"), worktreeDirectory: join(root, "worktrees") },
      }),
    ),
  ]);
  return {
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          error ? reject(error) : resolvePromise();
        });
      });
    },
    environment: {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      FAKE_CMUX_CALLS: join(root, "cmux-calls.jsonl"),
      FAKE_CMUX_STATE: join(root, "cmux-state.json"),
      GROUNDCREW_CONFIG: configPath,
      LINEAR_API_KEY: "test-key",
      LINEAR_API_URL: `http://127.0.0.1:${address.port}/graphql`,
      LINEAR_GROUNDCREW_LABEL_PREFIX: labelPrefix,
      PATH: `${fakeBin}:${process.env["PATH"]}`,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    },
    state,
  };
}

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      error ? reject(error) : resolvePromise();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("refusal server did not bind TCP");
  }
  return address.port;
}

function linearIssue(input: {
  readonly description?: string | undefined;
  readonly identifier?: string;
  readonly includeInReviewState?: boolean | undefined;
  readonly labelNames?: readonly string[];
  readonly state: LinearState;
  readonly stateName?: string;
  readonly stateType?: string;
}) {
  const identifier = input.identifier ?? "LIN-1";
  return {
    children: { nodes: [] },
    comments: {
      nodes: input.state.comments
        .map((body, index) => ({
          body,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        }))
        .toReversed(),
    },
    description: input.description ?? "A repository-free research task.",
    id: `issue-${identifier}`,
    identifier,
    inverseRelations: { nodes: [] },
    labels: { nodes: (input.labelNames ?? ["agent-codex"]).map((name) => ({ name })) },
    priority: 1,
    relations: { nodes: [] },
    state: {
      id: "state-current",
      name: input.stateName ?? input.state.stateName,
      type: input.stateType ?? input.state.stateType,
    },
    team: {
      states: {
        nodes: [
          { id: "state-todo", name: "Todo", type: "unstarted" },
          { id: "state-progress", name: "In Progress", type: "started" },
          ...(input.includeInReviewState === false
            ? []
            : [{ id: "state-review", name: "In Review", type: "started" }]),
        ],
      },
    },
    title: "Research task",
  };
}

function filteringScenarioIssues(input: {
  readonly includeInReviewState?: boolean | undefined;
  readonly labelPrefix: string;
  readonly state: LinearState;
}) {
  return [
    linearIssue({
      identifier: "LIN-ELIGIBLE",
      includeInReviewState: input.includeInReviewState,
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
    }),
    linearIssue({
      identifier: "LIN-COMPLETED",
      includeInReviewState: input.includeInReviewState,
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
      stateName: "Done",
      stateType: "completed",
    }),
    linearIssue({
      identifier: "LIN-BACKLOG",
      includeInReviewState: input.includeInReviewState,
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
      stateName: "Backlog",
      stateType: "backlog",
    }),
    linearIssue({
      identifier: "LIN-TRIAGE",
      includeInReviewState: input.includeInReviewState,
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
      stateName: "Triage",
      stateType: "triage",
    }),
    ...Array.from({ length: 247 }, (_, index) =>
      linearIssue({
        identifier: `LIN-UNRELATED-${index + 1}`,
        includeInReviewState: input.includeInReviewState,
        labelNames: [],
        state: input.state,
      }),
    ),
  ];
}

async function runCrew(input: {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFileAsync(process.execPath, ["bin/run.js", ...input.arguments], {
    cwd: process.cwd(),
    env: input.environment,
  });
}

async function runLinearList(input: {
  readonly environment: NodeJS.ProcessEnv;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await runLinearCommand({ command: "list", environment: input.environment, payload: {} });
}

async function runLinearUpdate(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly payload: Record<string, unknown>;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await runLinearCommand({
    command: "update",
    environment: input.environment,
    payload: input.payload,
  });
}

async function runLinearCommand(input: {
  readonly command: "list" | "update";
  readonly environment: NodeJS.ProcessEnv;
  readonly payload: Record<string, unknown>;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = execFile(
      process.execPath,
      [`task-sources/linear/${input.command}`],
      { cwd: process.cwd(), env: input.environment },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
    child.stdin?.end(JSON.stringify(input.payload));
  });
}
