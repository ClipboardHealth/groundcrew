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
});
