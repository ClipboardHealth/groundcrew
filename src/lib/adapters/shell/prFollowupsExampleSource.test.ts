/* eslint-disable no-template-curly-in-string -- this file embeds a fake `gh` bash script whose `${...}` tokens are literal shell parameter expansions, NOT JS template literals */

/**
 * Fixture-driven test for the committed pr-followups shell-source example
 * (`task-sources/pr-followups/pr-followups.sh`). It does NOT hit GitHub: a fake
 * `gh` executable on PATH emits canned payloads, the real script runs via
 * bash + jq, and its stdout is validated against the same Zod schemas the shell
 * adapter applies at runtime.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { snapshotEnvironmentVariables } from "../../../testHelpers/env.ts";
import { shellAdapterConfigSchema, shellFetchOutputSchema, shellIssueSchema } from "./schema.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const SCRIPT = path.join(REPO_ROOT, "task-sources/pr-followups/pr-followups.sh");

interface MergedPr {
  number: number;
  title: string;
  mergedAt: string;
  headRefName: string;
  body: string;
  author: { login: string };
}

/**
 * Build a fake `gh` on PATH. `prList` is the JSON array returned for
 * `gh pr list ... --json ...`; `prView` maps "<number>" -> one PR object for
 * `gh pr view <number> --json ...`. `repo view` and `auth status` succeed.
 */
function makeHarness(opts: {
  prList: MergedPr[];
  prView?: Record<string, MergedPr>;
  stateSeed?: { floor: string; handled: number[] };
}): {
  dir: string;
  stateDir: string;
  run: (
    args: string[],
    extra?: { env?: Record<string, string>; stdin?: string },
  ) => { status: number | null; stdout: string; stderr: string };
  readState: () => { floor: string; handled: number[] };
} {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-followups-"));
  const stateDir = path.join(dir, "state");
  const listFixture = path.join(dir, "list.json");
  const viewDir = path.join(dir, "views");
  writeFileSync(listFixture, JSON.stringify(opts.prList));
  // viewDir is created lazily by the fake only if needed; create eagerly:
  spawnSync("mkdir", ["-p", viewDir]);
  for (const [num, pr] of Object.entries(opts.prView ?? {})) {
    writeFileSync(path.join(viewDir, `${num}.json`), JSON.stringify(pr));
  }

  const fakeGh = path.join(dir, "gh");
  writeFileSync(
    fakeGh,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "repo" && "${2:-}" == "view" ]]; then printf "%s" "${FAKE_REPO:-acme/widgets}"; exit 0; fi',
      'if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then cat "$FAKE_LIST"; exit 0; fi',
      'if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then',
      '  f="$FAKE_VIEW_DIR/${3:-}.json"',
      '  [[ -f "$f" ]] || { echo "no pull requests found" >&2; exit 1; }',
      '  cat "$f"; exit 0',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGh, 0o755);

  if (opts.stateSeed) {
    spawnSync("mkdir", ["-p", stateDir]);
    writeFileSync(path.join(stateDir, "acme__widgets.json"), JSON.stringify(opts.stateSeed));
  }

  function run(
    args: string[],
    extra: { env?: Record<string, string>; stdin?: string } = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const baseEnv = snapshotEnvironmentVariables();
    const result = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      input: extra.stdin,
      env: {
        ...baseEnv,
        PATH: `${dir}:${baseEnv["PATH"] ?? ""}`,
        FAKE_LIST: listFixture,
        FAKE_VIEW_DIR: viewDir,
        PR_FOLLOWUPS_REPO: "acme/widgets",
        PR_FOLLOWUPS_BASE: "main",
        PR_FOLLOWUPS_STATE_DIR: stateDir,
        ...extra.env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  function readState(): { floor: string; handled: number[] } {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing untyped JSON.parse output to the known state shape
    return JSON.parse(readFileSync(path.join(stateDir, "acme__widgets.json"), "utf8")) as {
      floor: string;
      handled: number[];
    };
  }

  return { dir, stateDir, run, readState };
}

describe("pr-followups shell source", () => {
  it("verify succeeds when gh is authed and repo reachable", () => {
    const h = makeHarness({ prList: [] });
    const r = h.run(["verify"]);
    expect(r.status).toBe(0);
  });

  it("prints usage and exits 2 on unknown subcommand", () => {
    const h = makeHarness({ prList: [] });
    const r = h.run(["bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  it("list initializes state on first run with an empty handled set", () => {
    const h = makeHarness({ prList: [] });
    const r = h.run(["list"]);
    expect(r.status).toBe(0);
    const state = h.readState();
    expect(state.handled).toStrictEqual([]);
    // floor is an ISO-8601 Zulu timestamp.
    expect(state.floor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  const PRS: MergedPr[] = [
    {
      number: 101,
      title: "Add retry logic",
      mergedAt: "2026-06-10T10:00:00Z",
      headRefName: "feature/retry",
      body: "Body of 101",
      author: { login: "alice" },
    },
    {
      number: 102,
      title: "Already handled",
      mergedAt: "2026-06-11T10:00:00Z",
      headRefName: "feature/handled",
      body: "Body of 102",
      author: { login: "bob" },
    },
    {
      number: 103,
      title: "A followup PR",
      mergedAt: "2026-06-12T10:00:00Z",
      headRefName: "gc-followup/77-extract",
      body: "Body of 103",
      author: { login: "carol" },
    },
  ];

  it("emits one valid task per qualifying merged PR", () => {
    const h = makeHarness({
      prList: PRS,
      stateSeed: { floor: "2026-06-01T00:00:00Z", handled: [102] },
    });
    const r = h.run(["list"]);
    expect(r.status).toBe(0);
    const tasks = shellFetchOutputSchema.parse(JSON.parse(r.stdout));
    // 102 is handled, 103 is a followup branch -> only 101 emitted.
    expect(tasks.map((task) => task.id)).toStrictEqual(["followup-101"]);
    const [t] = tasks;
    expect(t).toBeDefined();
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.title).toBe("Refactor followup for #101: Add retry logic");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.status).toBe("todo");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.repository).toBe("acme/widgets");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.assignee).toBe("alice");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.updatedAt).toBe("2026-06-10T10:00:00Z");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.url).toBe("https://github.com/acme/widgets/pull/101");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.sourceRef).toStrictEqual({ number: 101 });
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.description).toContain("#101");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.description).toContain("gh pr diff 101");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.agent).toBeNull();
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.blockers).toStrictEqual([]);
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.hasMoreBlockers).toBe(false);
  });

  it("emits nothing when no PR is newer than the floor", () => {
    const h = makeHarness({
      prList: PRS,
      stateSeed: { floor: "2026-12-01T00:00:00Z", handled: [] },
    });
    const r = h.run(["list"]);
    expect(shellFetchOutputSchema.parse(JSON.parse(r.stdout))).toStrictEqual([]);
  });

  it("emits a default agent when PR_FOLLOWUPS_AGENT is set", () => {
    const [pr101] = PRS;
    expect(pr101).toBeDefined();
    const h = makeHarness({
      // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
      prList: [pr101!],
      stateSeed: { floor: "2026-06-01T00:00:00Z", handled: [] },
    });
    const r = h.run(["list"], { env: { PR_FOLLOWUPS_AGENT: "claude-fable" } });
    const [t] = shellFetchOutputSchema.parse(JSON.parse(r.stdout));
    expect(t).toBeDefined();
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    expect(t!.agent).toBe("claude-fable");
  });

  it("advances the floor across a contiguous handled/followup prefix and prunes", () => {
    // 201 handled, 202 followup branch, 203 PENDING (hole), 204 handled.
    const prs: MergedPr[] = [
      {
        number: 201,
        title: "h1",
        mergedAt: "2026-06-01T00:00:00Z",
        headRefName: "x/1",
        body: "",
        author: { login: "a" },
      },
      {
        number: 202,
        title: "fu",
        mergedAt: "2026-06-02T00:00:00Z",
        headRefName: "gc-followup/1-x",
        body: "",
        author: { login: "a" },
      },
      {
        number: 203,
        title: "pending",
        mergedAt: "2026-06-03T00:00:00Z",
        headRefName: "x/3",
        body: "",
        author: { login: "a" },
      },
      {
        number: 204,
        title: "h2",
        mergedAt: "2026-06-04T00:00:00Z",
        headRefName: "x/4",
        body: "",
        author: { login: "a" },
      },
    ];
    const h = makeHarness({
      prList: prs,
      stateSeed: { floor: "2026-05-01T00:00:00Z", handled: [201, 204] },
    });
    const r = h.run(["list"]);
    const tasks = shellFetchOutputSchema.parse(JSON.parse(r.stdout));
    // Only 203 is pending and emittable (201 handled, 202 followup, 204 handled).
    expect(tasks.map((t) => t.id)).toStrictEqual(["followup-203"]);

    const state = h.readState();
    // Floor advances past 201 and 202, stops at the 203 hole -> floor == 202's time.
    expect(state.floor).toBe("2026-06-02T00:00:00Z");
    // 201 (< new floor) pruned; 204 kept (still a hole above the floor).
    expect(state.handled.toSorted((a, b) => a - b)).toStrictEqual([204]);
  });

  it("keeps a handled PR tied exactly to the new floor in the set", () => {
    // Two handled PRs share a timestamp at the advancing boundary; the boundary
    // one must stay in `handled` so it is not re-emitted next poll.
    const prs: MergedPr[] = [
      {
        number: 301,
        title: "h",
        mergedAt: "2026-06-01T00:00:00Z",
        headRefName: "x/1",
        body: "",
        author: { login: "a" },
      },
      {
        number: 302,
        title: "h",
        mergedAt: "2026-06-02T00:00:00Z",
        headRefName: "x/2",
        body: "",
        author: { login: "a" },
      },
    ];
    const h = makeHarness({
      prList: prs,
      stateSeed: { floor: "2026-05-01T00:00:00Z", handled: [301, 302] },
    });
    h.run(["list"]);
    const state = h.readState();
    expect(state.floor).toBe("2026-06-02T00:00:00Z");
    // 301 (< floor) pruned, 302 (== floor) kept.
    expect(state.handled).toStrictEqual([302]);
  });

  it("get returns one valid task for a known followup id", () => {
    const pr: MergedPr = {
      number: 101,
      title: "Add retry logic",
      mergedAt: "2026-06-10T10:00:00Z",
      headRefName: "feature/retry",
      body: "Body",
      author: { login: "alice" },
    };
    const h = makeHarness({ prList: [], prView: { "101": pr } });
    const r = h.run(["get", "followup-101"]);
    expect(r.status).toBe(0);
    const task = shellIssueSchema.parse(JSON.parse(r.stdout));
    expect(task.id).toBe("followup-101");
    expect(task.sourceRef).toStrictEqual({ number: 101 });
  });

  it("get exits 3 when the PR is absent", () => {
    const h = makeHarness({ prList: [], prView: {} });
    const r = h.run(["get", "followup-999"]);
    expect(r.status).toBe(3);
  });

  it("complete records the PR number from stdin sourceRef", () => {
    const h = makeHarness({
      prList: [],
      stateSeed: { floor: "2026-06-01T00:00:00Z", handled: [] },
    });
    const r = h.run(["complete", "followup-123"], {
      stdin: JSON.stringify({ number: 123 }),
    });
    expect(r.status).toBe(0);
    expect(h.readState().handled).toStrictEqual([123]);
  });

  it("reviewed is idempotent and preserves the floor", () => {
    const h = makeHarness({
      prList: [],
      stateSeed: { floor: "2026-06-01T00:00:00Z", handled: [123] },
    });
    const r = h.run(["reviewed", "followup-123"], {
      stdin: JSON.stringify({ number: 123 }),
    });
    expect(r.status).toBe(0);
    const state = h.readState();
    expect(state.handled).toStrictEqual([123]);
    expect(state.floor).toBe("2026-06-01T00:00:00Z");
  });

  it("source.json commands parse against the shell adapter config schema", () => {
    const raw = readFileSync(path.join(REPO_ROOT, "task-sources/pr-followups/source.json"), "utf8");
    // shellAdapterConfigSchema.parse accepts `unknown`; pass the JSON.parse
    // output directly so the schema itself validates and narrows the types.
    const parsed = shellAdapterConfigSchema.parse(JSON.parse(raw));
    expect(parsed.name).toBe("pr-followups");
    expect(parsed.commands.listTasks).toContain("pr-followups.sh list");
    expect(parsed.commands.markInReview).toContain("reviewed");
    expect(parsed.commands.markDone).toContain("complete");
  });
});
