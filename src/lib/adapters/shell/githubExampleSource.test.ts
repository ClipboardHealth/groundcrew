/* eslint-disable no-template-curly-in-string -- this file embeds a fake `gh` bash script whose `${...}` tokens are literal shell parameter expansions, NOT JS template literals */

/**
 * Fixture-driven test for the committed GitHub shell-source example
 * (`task-sources/github/github.sh`). It does NOT hit GitHub: a fake `gh`
 * executable on PATH serves canned issues and records every invocation, the
 * real script runs via bash + jq, and its stdout is validated against the same
 * Zod schemas the shell adapter applies at runtime. This pins the jq transform
 * (id encoding, label-based status mapping, comment folding) that `list` and
 * `get` share, plus the label/close calls `move` makes.
 *
 * The fake mirrors gh 2.93's shapes: `search issues --json url --jq '.[].url'`
 * prints one issue URL per line, and `issue view --json ...` prints the issue
 * object (a URL or a number + `-R owner/repo` both address it).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { snapshotEnvironmentVariables } from "../../../testHelpers/env.ts";
import { shellFetchOutputSchema, shellIssueSchema } from "./schema.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const SCRIPT = path.join(REPO_ROOT, "task-sources/github/github.sh");

/** A GitHub issue, as `gh issue view --json <VIEW_FIELDS>` returns it. */
interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  updatedAt: string;
  url: string;
  comments: Array<{ author: { login: string }; createdAt: string; body: string }>;
}

function issue(
  repo: string,
  number: number,
  overrides: Partial<GitHubIssue> = {},
  kind: "issues" | "pull" = "issues",
): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: "OPEN",
    labels: [{ name: "groundcrew" }],
    assignees: [{ login: "alice" }],
    updatedAt: "2026-09-20T10:00:00Z",
    url: `https://github.com/${repo}/${kind}/${number}`,
    comments: [],
    ...overrides,
  };
}

const OPEN_ISSUES = [
  issue("ClipboardHealth/api", 1, {
    labels: [{ name: "groundcrew" }, { name: "agent:codex" }],
    comments: [
      { author: { login: "dana" }, createdAt: "2026-09-20T11:00:00Z", body: "looks good" },
      { author: { login: "eli" }, createdAt: "2026-09-20T12:00:00Z", body: "ship it" },
    ],
  }),
  issue("ClipboardHealth/api", 2, {
    labels: [{ name: "groundcrew" }, { name: "groundcrew:in-progress" }],
  }),
  issue("acme/web-app", 3, {
    assignees: [],
    labels: [
      { name: "groundcrew" },
      { name: "groundcrew:in-progress" },
      { name: "groundcrew:in-review" },
    ],
  }),
];
const CLOSED_ISSUES = [issue("acme/web-app", 4, { state: "CLOSED", body: "" })];
const PULL_REQUEST = issue("acme/web-app", 5, {}, "pull");

interface Harness {
  dir: string;
  calls: string;
  cleanup: () => void;
}

/** Fixture file name for an issue: its lower-cased task id. */
function fixtureName(value: GitHubIssue): string {
  const [, owner, repo] = /github\.com\/([^/]+)\/([^/]+)\//.exec(value.url) ?? [];
  return `${owner}__${repo}-${value.number}`.toLowerCase();
}

function setup(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "github-example-"));
  const calls = path.join(dir, "calls.log");
  const viewDir = path.join(dir, "views");
  mkdirSync(viewDir);
  for (const i of [...OPEN_ISSUES, ...CLOSED_ISSUES, PULL_REQUEST]) {
    writeFileSync(path.join(viewDir, `${fixtureName(i)}.json`), JSON.stringify(i));
  }
  writeFileSync(path.join(dir, "open.txt"), OPEN_ISSUES.map((i) => i.url).join("\n"));
  writeFileSync(path.join(dir, "closed.txt"), CLOSED_ISSUES.map((i) => i.url).join("\n"));

  // Fake `gh`: logs each invocation's args (one line, space-joined) to
  // $GH_CALLS. `search issues` prints the fixture URLs for its --state
  // (FAKE_SEARCH_FAIL replays a failure). `issue view` resolves a URL or a
  // number + -R to a fixture file (gh's not-found wording + exit 1 when absent;
  // FAKE_VIEW_FAIL/_KEY replays a transient failure) and applies --jq with real
  // jq. Everything else (label create, issue edit/close, auth status) succeeds.
  const fakeGh = path.join(dir, "gh");
  writeFileSync(
    fakeGh,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "$GH_CALLS"',
      'sub="${1:-} ${2:-}"; shift 2 || true',
      'target="" repo="" state="" jqexpr=""',
      "while [[ $# -gt 0 ]]; do",
      '  case "$1" in',
      '    -R) repo="$2"; shift 2 ;;',
      '    --state) state="$2"; shift 2 ;;',
      '    --jq) jqexpr="$2"; shift 2 ;;',
      "    --json|--limit|--closed) shift 2 ;;",
      '    *) [[ -n "$target" ]] || target="$1"; shift ;;',
      "  esac",
      "done",
      'case "$sub" in',
      '  "search issues")',
      '    if [[ -n "${FAKE_SEARCH_FAIL:-}" ]]; then echo "$FAKE_SEARCH_FAIL" >&2; exit 1; fi',
      '    cat "$FIXTURE_DIR/$state.txt"; echo ;;',
      '  "issue view")',
      '    if [[ "$target" =~ ^https://github.com/([^/]+)/([^/]+)/[a-z]+/([0-9]+)$ ]]; then',
      '      key="${BASH_REMATCH[1]}__${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"',
      "    else",
      '      key="${repo/\\//__}-$target"',
      "    fi",
      "    key=\"$(printf '%s' \"$key\" | tr '[:upper:]' '[:lower:]')\"",
      '    if [[ -n "${FAKE_VIEW_FAIL:-}" && "$key" == "${FAKE_VIEW_FAIL_KEY:-}" ]]; then',
      '      echo "$FAKE_VIEW_FAIL" >&2; exit 1',
      "    fi",
      '    f="$FIXTURE_DIR/views/$key.json"',
      '    [[ -f "$f" ]] || { echo "GraphQL: Could not resolve to an issue or pull request with the number of $target. (repository.issue)" >&2; exit 1; }',
      '    if [[ -n "$jqexpr" ]]; then jq -r "$jqexpr" "$f"; else cat "$f"; fi ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGh, 0o755);

  return {
    dir,
    calls,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function run(
  h: Harness,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const baseEnv = snapshotEnvironmentVariables();
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      PATH: `${h.dir}:${baseEnv["PATH"] ?? ""}`,
      GH_CALLS: h.calls,
      FIXTURE_DIR: h.dir,
      GITHUB_DEFAULT_AGENT: "claude",
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function calls(h: Harness): string[] {
  return readFileSync(h.calls, "utf8").trim().split("\n");
}

describe("github.sh example source", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("list emits open and recently closed issues that satisfy the shell adapter schema", () => {
    const { status, stdout } = run(h, ["list"]);

    expect(status).toBe(0);
    const actual = shellFetchOutputSchema.parse(JSON.parse(stdout));
    expect(actual.map((i) => i.id)).toStrictEqual([
      "ClipboardHealth__api-1",
      "ClipboardHealth__api-2",
      "acme__web-app-3",
      "acme__web-app-4",
    ]);
  });

  it("maps open/closed state and status labels to the canonical enum", () => {
    const parsed = shellFetchOutputSchema.parse(JSON.parse(run(h, ["list"]).stdout));
    const byId = Object.fromEntries(parsed.map((i) => [i.id, i]));

    expect(byId["ClipboardHealth__api-1"]?.status).toBe("todo"); // open, no status label
    expect(byId["ClipboardHealth__api-2"]?.status).toBe("in-progress");
    expect(byId["acme__web-app-3"]?.status).toBe("in-review"); // wins over in-progress
    expect(byId["acme__web-app-4"]?.status).toBe("done"); // closed
  });

  it("takes the repository from the issue and the agent from its label or the default", () => {
    const parsed = shellFetchOutputSchema.parse(JSON.parse(run(h, ["list"]).stdout));
    const byId = Object.fromEntries(parsed.map((i) => [i.id, i]));

    expect(byId["ClipboardHealth__api-1"]?.repository).toBe("ClipboardHealth/api");
    expect(byId["ClipboardHealth__api-1"]?.agent).toBe("codex"); // label wins over default
    expect(byId["acme__web-app-3"]?.repository).toBe("acme/web-app");
    expect(byId["acme__web-app-3"]?.agent).toBe("claude"); // no label -> default
    expect(byId["acme__web-app-3"]?.assignee).toBe("Unassigned");
  });

  it("emits null agent when no label and no default are set", () => {
    const parsed = shellFetchOutputSchema.parse(
      JSON.parse(run(h, ["list"], { GITHUB_DEFAULT_AGENT: "" }).stdout),
    );

    expect(parsed.find((i) => i.id === "acme__web-app-3")?.agent).toBeNull();
  });

  it("searches with the default query and a 7-day closed window", () => {
    const expectedSince = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    run(h, ["list"]);

    const actual = calls(h).filter((c) => c.startsWith("search issues"));
    expect(actual).toHaveLength(2);
    expect(actual[0]).toContain("label:groundcrew assignee:@me --state open");
    expect(actual[1]).toContain(
      `label:groundcrew assignee:@me --state closed --closed >=${expectedSince}`,
    );
  });

  it("list logs and skips an issue whose view enrichment fails", () => {
    const { status, stdout, stderr } = run(h, ["list"], {
      FAKE_VIEW_FAIL: "HTTP 502: Bad Gateway",
      FAKE_VIEW_FAIL_KEY: "clipboardhealth__api-2",
    });

    expect(status).toBe(0);
    const actual = shellFetchOutputSchema.parse(JSON.parse(stdout));
    expect(actual.map((i) => i.id)).not.toContain("ClipboardHealth__api-2");
    expect(actual).toHaveLength(3);
    expect(stderr).toContain("skipping https://github.com/ClipboardHealth/api/issues/2");
  });

  it("propagates a search failure instead of masking it as no tasks", () => {
    const { status, stdout, stderr } = run(h, ["list"], {
      FAKE_SEARCH_FAIL: "HTTP 401: Bad credentials",
    });

    expect(status).not.toBe(0);
    expect(stderr).toContain("401");
    expect(stdout).toBe("");
  });

  it("get resolves a lower-cased id (as groundcrew passes it) to one ShellIssue", () => {
    const { status, stdout } = run(h, ["get", "clipboardhealth__api-1"]);

    expect(status).toBe(0);
    const actual = shellIssueSchema.parse(JSON.parse(stdout));
    expect(actual.title).toBe("Issue 1");
    expect(actual.url).toBe("https://github.com/ClipboardHealth/api/issues/1");
    expect(actual.sourceRef).toStrictEqual({ repository: "ClipboardHealth/api", number: 1 });
    expect(calls(h)).toContain(
      "issue view 1 -R clipboardhealth/api --json number,title,body,state,labels,assignees,updatedAt,url,comments",
    );
  });

  it("prepends the repository header and appends comments to the description", () => {
    const actual = shellIssueSchema.parse(
      JSON.parse(run(h, ["get", "clipboardhealth__api-1"]).stdout),
    );

    expect(actual.description).toMatch(
      /^Repository: ClipboardHealth\/api\nIssue: https:\/\/github\.com\/ClipboardHealth\/api\/issues\/1\n\nBody 1/,
    );
    expect(actual.description).toContain("--- Comments ---");
    expect(actual.description).toContain("[dana (2026-09-20T11:00:00Z)]\nlooks good");
    expect(actual.description).toContain("[eli (2026-09-20T12:00:00Z)]\nship it");
  });

  it("omits the comments section when an issue has none", () => {
    const actual = shellIssueSchema.parse(JSON.parse(run(h, ["get", "acme__web-app-4"]).stdout));

    expect(actual.description).not.toContain("--- Comments ---");
  });

  it("get exits 3 (not-found sentinel) for a missing issue", () => {
    expect(run(h, ["get", "acme__web-app-99"]).status).toBe(3);
  });

  it("get exits 3 for a pull request number", () => {
    expect(run(h, ["get", "acme__web-app-5"]).status).toBe(3);
  });

  it("get surfaces a real failure instead of the not-found sentinel", () => {
    const { status, stdout, stderr } = run(h, ["get", "acme__web-app-4"], {
      FAKE_VIEW_FAIL: "HTTP 401: Bad credentials",
      FAKE_VIEW_FAIL_KEY: "acme__web-app-4",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("401");
    expect(stdout).toBe("");
  });

  it("rejects a malformed id", () => {
    const { status, stderr } = run(h, ["get", "not-an-id"]);

    expect(status).toBe(2);
    expect(stderr).toContain("malformed task id");
  });

  it("move in-review swaps the status labels and creates the label on first use", () => {
    const { status } = run(h, ["move", "clipboardhealth__api-2", "in-review"]);

    expect(status).toBe(0);
    const actual = calls(h);
    expect(actual).toContain("label create groundcrew:in-review -R clipboardhealth/api");
    expect(actual).toContain(
      "issue edit 2 -R clipboardhealth/api --remove-label groundcrew:in-progress --add-label groundcrew:in-review",
    );
    expect(actual.some((c) => c.startsWith("issue close"))).toBe(false);
  });

  it("move in-progress only removes status labels the issue carries", () => {
    run(h, ["move", "clipboardhealth__api-1", "in-progress"]);

    expect(calls(h)).toContain(
      "issue edit 1 -R clipboardhealth/api --add-label groundcrew:in-progress",
    );
  });

  it("move done strips the status labels and closes the issue", () => {
    const { status } = run(h, ["move", "acme__web-app-3", "done"]);

    expect(status).toBe(0);
    const actual = calls(h);
    expect(actual).toContain(
      "issue edit 3 -R acme/web-app --remove-label groundcrew:in-progress --remove-label groundcrew:in-review",
    );
    expect(actual).toContain("issue close 3 -R acme/web-app");
    expect(actual.some((c) => c.startsWith("label create"))).toBe(false);
  });

  it("move rejects an unknown state", () => {
    const { status, stderr } = run(h, ["move", "acme__web-app-3", "shipped"]);

    expect(status).toBe(2);
    expect(stderr).toContain("unknown state");
  });

  it("verify checks gh authentication", () => {
    expect(run(h, ["verify"]).status).toBe(0);
    expect(calls(h)).toStrictEqual(["auth status"]);
  });
});
