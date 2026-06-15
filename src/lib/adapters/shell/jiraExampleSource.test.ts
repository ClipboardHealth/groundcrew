/* eslint-disable no-template-curly-in-string -- this file embeds a fake `jira` bash script whose `${...}` tokens are literal shell parameter expansions, NOT JS template literals */

/**
 * Fixture-driven test for the committed JIRA shell-source example
 * (`task-sources/jira/jira.sh`). It does NOT hit a live JIRA: a fake `jira`
 * executable on PATH emits canned payloads, the real script runs via bash + jq,
 * and its stdout is validated against the same Zod schemas the shell adapter
 * applies at runtime. This pins the jq transform (status mapping, label
 * decoding, ADF flattening, URL synthesis) that `list` and `get` share.
 *
 * The fake mirrors jira-cli 1.7.0's two distinct shapes: `issue list --raw`
 * returns a reduced top-level array (key + a trimmed `fields`, no id/self/
 * statusCategory), while `issue view <KEY> --raw` returns the full REST issue.
 * The `list` path therefore enriches each listed key via `view`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { snapshotEnvironmentVariables } from "../../../testHelpers/env.ts";
import { shellFetchOutputSchema, shellIssueSchema } from "./schema.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const SCRIPT = path.join(REPO_ROOT, "task-sources/jira/jira.sh");

/** One JIRA comment; `body` is a plain string (REST v2) or ADF object (v3). */
interface JiraComment {
  author: { displayName: string };
  created: string;
  body: string | Record<string, unknown>;
}

/** A full JIRA Cloud REST issue, as `jira issue view --raw` returns it. */
interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: string | Record<string, unknown>;
    status: { name: string; statusCategory: { key: string; name: string } };
    labels: string[];
    assignee: { displayName: string } | null;
    updated: string;
    comment?: { comments: JiraComment[] };
  };
}

/** The full issues `view` returns, keyed for the `list` enrichment lookup. */
const ISSUES: JiraIssue[] = [
  {
    id: "10001",
    key: "ENG-1",
    self: "https://acme.atlassian.net/rest/api/3/issue/10001",
    fields: {
      summary: "First",
      description: "Do the thing",
      status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
      labels: ["repo:ClipboardHealth__api", "agent:codex"],
      assignee: { displayName: "Alice" },
      updated: "2026-05-22T15:00:00.000+0000",
      comment: {
        comments: [
          {
            author: { displayName: "Dana" },
            created: "2026-05-22T16:00:00.000+0000",
            body: "looks good",
          },
          {
            author: { displayName: "Eli" },
            created: "2026-05-22T17:00:00.000+0000",
            // ADF comment body, as JIRA Cloud returns it.
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "ship it" }] }],
            },
          },
        ],
      },
    },
  },
  {
    id: "10002",
    key: "ENG-2",
    self: "https://acme.atlassian.net/rest/api/3/issue/10002",
    fields: {
      summary: "Second",
      // ADF (rich text) description, as JIRA Cloud returns it.
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Investigate" },
              { type: "text", text: "the bug" },
            ],
          },
        ],
      },
      status: {
        name: "In Review",
        statusCategory: { key: "indeterminate", name: "In Progress" },
      },
      labels: ["repo:org__repo"],
      assignee: { displayName: "Bob" },
      updated: "2026-05-21T10:00:00.000+0000",
    },
  },
  {
    id: "10003",
    key: "ENG-3",
    self: "https://acme.atlassian.net/rest/api/3/issue/10003",
    fields: {
      summary: "Third",
      status: {
        name: "In Progress",
        statusCategory: { key: "indeterminate", name: "In Progress" },
      },
      labels: [],
      assignee: null,
      updated: "2026-05-20T09:00:00.000+0000",
    },
  },
  {
    id: "10004",
    key: "ENG-4",
    self: "https://acme.atlassian.net/rest/api/3/issue/10004",
    fields: {
      summary: "Fourth",
      description: "done body",
      status: { name: "Done", statusCategory: { key: "done", name: "Done" } },
      labels: ["repo:a__b", "agent:claude"],
      assignee: { displayName: "Carol" },
      updated: "2026-05-19T08:00:00.000+0000",
    },
  },
];

/**
 * What `jira issue list --raw` actually returns: a top-level array of reduced
 * issues — only `key` plus a trimmed `fields` (no id, self, or statusCategory).
 * The script reads just the keys from this and enriches each via `view`.
 */
const LIST_OUTPUT = ISSUES.map((i) => ({
  key: i.key,
  fields: { summary: i.fields.summary, status: { name: i.fields.status.name } },
}));

interface Harness {
  dir: string;
  tokenFile: string;
  tokenEcho: string;
  listFixture: string;
  viewDir: string;
  cleanup: () => void;
}

function setup(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "jira-example-"));
  const tokenFile = path.join(dir, "jira.token");
  writeFileSync(tokenFile, "fake-token");

  const listFixture = path.join(dir, "list.json");
  const tokenEcho = path.join(dir, "token.echo");
  writeFileSync(listFixture, JSON.stringify(LIST_OUTPUT));

  // One full-issue file per key, named <KEY>.json, for the `view` lookup.
  const viewDir = path.join(dir, "views");
  mkdirSync(viewDir);
  for (const i of ISSUES) {
    writeFileSync(path.join(viewDir, `${i.key}.json`), JSON.stringify(i));
  }

  // Fake `jira` CLI: `list` echoes the reduced array; `view <KEY>` returns the
  // full issue file (a realistic not-found message + exit 1 when absent, the
  // sentinel `get` keys off; FAKE_VIEW_FAIL/_KEY replays a transient failure for
  // a chosen key); `me` records the exported JIRA_API_TOKEN so a test can assert
  // trimming.
  const fakeJira = path.join(dir, "jira");
  writeFileSync(
    fakeJira,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "me" ]]; then printf "%s" "${JIRA_API_TOKEN:-}" > "$TOKEN_ECHO"; exit 0; fi',
      // jira-cli exits non-zero (printing to stderr) when `list` matches nothing
      // OR on a real error (auth/network). FAKE_LIST_FAIL replays that: its value
      // is the stderr message, and the fake exits 1 — letting tests drive both
      // the "no result" and the genuine-failure branches of the script.
      'if [[ "${1:-}" == "issue" && "${2:-}" == "list" ]]; then',
      '  if [[ -n "${FAKE_LIST_FAIL:-}" ]]; then echo "$FAKE_LIST_FAIL" >&2; exit 1; fi',
      '  cat "$FIXTURE_LIST"; exit 0',
      "fi",
      'if [[ "${1:-}" == "issue" && "${2:-}" == "view" ]]; then',
      '  if [[ -n "${FAKE_VIEW_FAIL:-}" && "${3:-}" == "${FAKE_VIEW_FAIL_KEY:-}" ]]; then',
      '    echo "$FAKE_VIEW_FAIL" >&2; exit 1',
      "  fi",
      '  f="$VIEW_DIR/${3:-}.json"',
      '  [[ -f "$f" ]] || { echo "✗ Issue ${3:-} does not exist" >&2; exit 1; }',
      '  cat "$f"; exit 0',
      "fi",
      'if [[ "${1:-}" == "issue" && "${2:-}" == "move" ]]; then exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeJira, 0o755);

  return {
    dir,
    tokenFile,
    tokenEcho,
    listFixture,
    viewDir,
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
      JIRA_TOKEN_FILE: h.tokenFile,
      JIRA_REVIEW_PATTERN: "review",
      JIRA_DEFAULT_AGENT: "claude",
      FIXTURE_LIST: h.listFixture,
      VIEW_DIR: h.viewDir,
      TOKEN_ECHO: h.tokenEcho,
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("jira.sh example source", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("list emits ShellIssue[] that satisfies the shell adapter schema", () => {
    const { status, stdout } = run(h, ["list"]);
    expect(status).toBe(0);

    const parsed = shellFetchOutputSchema.parse(JSON.parse(stdout));
    expect(parsed).toHaveLength(4);
  });

  it("maps statusCategory and review status name to the canonical enum", () => {
    const parsed = shellFetchOutputSchema.parse(JSON.parse(run(h, ["list"]).stdout));
    const byId = Object.fromEntries(parsed.map((i) => [i.id, i]));

    expect(byId["ENG-1"]?.status).toBe("todo"); // statusCategory new
    expect(byId["ENG-2"]?.status).toBe("in-review"); // indeterminate + name matches review pattern
    expect(byId["ENG-3"]?.status).toBe("in-progress"); // indeterminate, non-review name
    expect(byId["ENG-4"]?.status).toBe("done"); // statusCategory done
  });

  it("decodes repo/agent labels and falls back to the default agent", () => {
    const parsed = shellFetchOutputSchema.parse(JSON.parse(run(h, ["list"]).stdout));
    const byId = Object.fromEntries(parsed.map((i) => [i.id, i]));

    expect(byId["ENG-1"]?.repository).toBe("ClipboardHealth/api");
    expect(byId["ENG-1"]?.agent).toBe("codex"); // label wins over default
    expect(byId["ENG-2"]?.repository).toBe("org/repo");
    expect(byId["ENG-2"]?.agent).toBe("claude"); // no label -> default
    expect(byId["ENG-3"]?.repository).toBeNull(); // no repo label -> not dispatchable
  });

  it("emits null agent when no label and no default are set", () => {
    const parsed = shellFetchOutputSchema.parse(
      JSON.parse(run(h, ["list"], { JIRA_DEFAULT_AGENT: "" }).stdout),
    );
    const byId = Object.fromEntries(parsed.map((i) => [i.id, i]));
    expect(byId["ENG-3"]?.agent).toBeNull();
  });

  it("flattens ADF descriptions and synthesizes the browse URL + sourceRef", () => {
    const parsed = shellFetchOutputSchema.parse(JSON.parse(run(h, ["list"]).stdout));
    const byId = Object.fromEntries(parsed.map((i) => [i.id, i]));

    const eng2 = byId["ENG-2"];
    expect(eng2?.description).toContain("Investigate");
    expect(eng2?.description).toContain("Repository: org/repo");
    expect(eng2?.url).toBe("https://acme.atlassian.net/browse/ENG-2");
    expect(eng2?.sourceRef).toStrictEqual({ key: "ENG-2", nativeId: "10002" });
    expect(eng2?.title).toBe("Second");
    expect(eng2?.assignee).toBe("Bob");
  });

  it("folds jira's no-result exit into an empty array (exit 0)", () => {
    // The steady state when no issue carries the dispatch label: jira-cli exits
    // non-zero, but the script must report "no tasks" (empty array, exit 0), not
    // a fetch failure — otherwise the shell adapter throws on every poll.
    const { status, stdout } = run(h, ["list"], {
      FAKE_LIST_FAIL: '✗ No result found for given query in project "ENG"',
    });
    expect(status).toBe(0);
    expect(shellFetchOutputSchema.parse(JSON.parse(stdout))).toStrictEqual([]);
  });

  it("propagates a real list failure instead of masking it as no tasks", () => {
    const { status, stdout, stderr } = run(h, ["list"], {
      FAKE_LIST_FAIL: "✗ Received unexpected response: 401 Unauthorized",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("401 Unauthorized");
    expect(stdout).toBe(""); // no `[]` — the empty-result branch must not run
  });

  it("list logs and skips an issue whose view enrichment fails", () => {
    // A transient `view` failure on one key must not drop the whole list: the
    // script logs the skip and keeps the issues it could enrich.
    const { status, stdout, stderr } = run(h, ["list"], {
      FAKE_VIEW_FAIL: "✗ Received unexpected response: 503 Service Unavailable",
      FAKE_VIEW_FAIL_KEY: "ENG-2",
    });
    expect(status).toBe(0);

    const parsed = shellFetchOutputSchema.parse(JSON.parse(stdout));
    expect(parsed).toHaveLength(3); // ENG-1/3/4 present, ENG-2 dropped
    expect(parsed.map((i) => i.id)).not.toContain("ENG-2");
    expect(stderr).toContain("skipping ENG-2");
  });

  it("get emits one ShellIssue for a known key", () => {
    const { status, stdout } = run(h, ["get", "ENG-1"]);
    expect(status).toBe(0);

    const parsed = shellIssueSchema.parse(JSON.parse(stdout));
    expect(parsed.id).toBe("ENG-1");
    expect(parsed.repository).toBe("ClipboardHealth/api");
  });

  it("appends issue comments (string and ADF bodies) to the description", () => {
    const parsed = shellIssueSchema.parse(JSON.parse(run(h, ["get", "ENG-1"]).stdout));

    expect(parsed.description).toContain("Do the thing"); // original body still present
    expect(parsed.description).toContain("--- Comments ---");
    expect(parsed.description).toContain("Dana"); // first comment author
    expect(parsed.description).toContain("looks good"); // string-body comment
    expect(parsed.description).toContain("Eli"); // second comment author
    expect(parsed.description).toContain("ship it"); // ADF-body comment, flattened
  });

  it("omits the comments section when an issue has none", () => {
    const parsed = shellIssueSchema.parse(JSON.parse(run(h, ["get", "ENG-3"]).stdout));
    expect(parsed.description).not.toContain("--- Comments ---");
  });

  it("get exits 3 (not-found sentinel) when jira cannot find the key", () => {
    expect(run(h, ["get", "MISSING-9"]).status).toBe(3);
  });

  it("get surfaces a real failure instead of the not-found sentinel", () => {
    // A transient auth/network blip during a getTask poll must not be mistaken
    // for a deleted task: exit 1 (retryable), not 3 (vanished).
    const { status, stdout, stderr } = run(h, ["get", "ENG-1"], {
      FAKE_VIEW_FAIL: "✗ Received unexpected response: 401 Unauthorized",
      FAKE_VIEW_FAIL_KEY: "ENG-1",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("401");
    expect(stdout).toBe("");
  });

  it("verify exits 0 when the token file is present", () => {
    expect(run(h, ["verify"]).status).toBe(0);
  });

  it("trims surrounding whitespace from the token before exporting it", () => {
    // A file saved with `echo`, CRLF line endings, or stray spaces must still
    // authenticate; the script exports the trimmed value as JIRA_API_TOKEN.
    writeFileSync(h.tokenFile, "  fake-token \r\n");
    expect(run(h, ["verify"]).status).toBe(0);
    expect(readFileSync(h.tokenEcho, "utf8")).toBe("fake-token");
  });

  it("fails fast when the token file is present but empty", () => {
    // A readable-but-empty (or whitespace-only) token file would otherwise
    // export an empty JIRA_API_TOKEN and surface a cryptic auth failure deep in
    // a `jira` call; reject it up front with a clear message instead.
    writeFileSync(h.tokenFile, "  \r\n");
    const { status, stderr } = run(h, ["verify"]);
    expect(status).toBe(1);
    expect(stderr).toContain("empty");
  });
});
