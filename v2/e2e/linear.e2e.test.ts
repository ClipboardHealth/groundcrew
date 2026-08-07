import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

  it("paginates list queries beneath Linear's complexity limit", async () => {
    await fixture.close();
    fixture = await createLinearFixture({ listedTaskCount: 21 });

    const doctor = await runCrew({ arguments: ["doctor"], environment: fixture.environment });

    expect(doctor.stdout).toContain("live list probe: healthy (21 tasks)");
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
    expect(fixture.state.comments.some((comment) => comment.includes("first-output"))).toBe(true);
    expect(fixture.state.comments.some((comment) => comment.includes("second-output"))).toBe(true);
  });
});

interface LinearState {
  comments: string[];
  stateName: string;
  stateType: string;
}

async function createLinearFixture(
  input: { readonly issueDescription?: string; readonly listedTaskCount?: number } = {},
): Promise<{
  readonly close: () => Promise<void>;
  readonly environment: NodeJS.ProcessEnv;
  readonly state: LinearState;
}> {
  const listedTaskCount = input.listedTaskCount ?? 1;
  const state: LinearState = { comments: [], stateName: "Todo", stateType: "unstarted" };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
    }
    const body = JSON.parse(raw);
    const issue = linearIssue({ description: input.issueDescription, state });
    let data;
    if (body.operationName === "GroundcrewList") {
      if (listedTaskCount > 20 && body.query.includes("first: 100")) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ errors: [{ message: "Query too complex" }] }));
        return;
      }
      const pageStart = body.variables.after === undefined ? 0 : Number(body.variables.after);
      const pageEnd = Math.min(pageStart + 20, listedTaskCount);
      const nodes = Array.from({ length: pageEnd - pageStart }, (_, offset) =>
        linearIssue({
          description: input.issueDescription,
          identifier: `LIN-${pageStart + offset + 1}`,
          state,
        }),
      );
      data = {
        viewer: {
          assignedIssues: {
            nodes,
            pageInfo: {
              endCursor: pageEnd < listedTaskCount ? String(pageEnd) : undefined,
              hasNextPage: pageEnd < listedTaskCount,
            },
          },
        },
      };
    } else if (body.operationName === "GroundcrewIssue") {
      data = { issue };
    } else if (body.operationName === "GroundcrewComment") {
      state.comments.push(body.variables.input.body);
      data = { commentCreate: { success: true } };
    } else if (body.operationName === "GroundcrewMove") {
      const stateId = body.variables.input.stateId;
      state.stateName = stateId === "state-review" ? "In Review" : "In Progress";
      state.stateType = "started";
      data = { issueUpdate: { success: true } };
    } else {
      response.statusCode = 400;
      data = {};
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data }));
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
  readonly state: LinearState;
}) {
  const identifier = input.identifier ?? "LIN-1";
  return {
    children: { nodes: [] },
    comments: { nodes: input.state.comments.map((body) => ({ body })) },
    description: input.description ?? "A repository-free research task.",
    id: `issue-${identifier}`,
    identifier,
    inverseRelations: { nodes: [] },
    labels: { nodes: [{ name: "agent-codex" }] },
    priority: 1,
    relations: { nodes: [] },
    state: { id: "state-current", name: input.state.stateName, type: input.state.stateType },
    team: {
      states: {
        nodes: [
          { id: "state-progress", name: "In Progress", type: "started" },
          { id: "state-review", name: "In Review", type: "started" },
        ],
      },
    },
    title: "Research task",
  };
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
beforeAll(async () => {
  await Promise.all(
    ["claude", "cmux", "codex"].map(
      async (executable) => await chmod(`e2e/fixtures/fake-bin/${executable}`, 0o755),
    ),
  );
});
