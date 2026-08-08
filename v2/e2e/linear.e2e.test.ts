import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("the shipped Linear source", () => {
  let fixture: Awaited<ReturnType<typeof createLinearFixture>>;

  beforeEach(async () => {
    fixture = await createLinearFixture();
  });

  afterEach(async () => {
    await fixture.close();
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
  stateName: string;
  stateType: string;
}

async function createLinearFixture(
  input: {
    readonly filteringScenario?: boolean;
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
      const issue = linearIssue({ description: input.issueDescription, state });
      let data;
      if (body.operationName === "GroundcrewList") {
        state.listRequests.push({ query: body.query, variables: body.variables });
        const listedIssues = input.filteringScenario
          ? filteringScenarioIssues({ labelPrefix, state })
          : Array.from({ length: listedTaskCount }, (_, index) =>
              linearIssue({
                description: input.issueDescription,
                identifier: `LIN-${index + 1}`,
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

function linearIssue(input: {
  readonly description?: string | undefined;
  readonly identifier?: string;
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
          { id: "state-review", name: "In Review", type: "started" },
        ],
      },
    },
    title: "Research task",
  };
}

function filteringScenarioIssues(input: {
  readonly labelPrefix: string;
  readonly state: LinearState;
}) {
  return [
    linearIssue({
      identifier: "LIN-ELIGIBLE",
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
    }),
    linearIssue({
      identifier: "LIN-COMPLETED",
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
      stateName: "Done",
      stateType: "completed",
    }),
    linearIssue({
      identifier: "LIN-BACKLOG",
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
      stateName: "Backlog",
      stateType: "backlog",
    }),
    linearIssue({
      identifier: "LIN-TRIAGE",
      labelNames: [`${input.labelPrefix}codex`],
      state: input.state,
      stateName: "Triage",
      stateType: "triage",
    }),
    ...Array.from({ length: 247 }, (_, index) =>
      linearIssue({ identifier: `LIN-UNRELATED-${index + 1}`, labelNames: [], state: input.state }),
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
  return await new Promise((resolvePromise, reject) => {
    const child = execFile(
      process.execPath,
      ["task-sources/linear/list"],
      { cwd: process.cwd(), env: input.environment },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
    child.stdin?.end("{}");
  });
}
