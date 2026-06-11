/* eslint-disable no-template-curly-in-string -- this file embeds a fake `jira` bash script whose `${...}` tokens are literal shell parameter expansions, NOT JS template literals */

/**
 * Fixture-driven test for the committed JIRA shell-source example
 * (`examples/jira/jira.sh`). It does NOT hit a live JIRA: a fake `jira`
 * executable on PATH emits canned `--raw` REST payloads, the real script runs
 * via bash + jq, and its stdout is validated against the same Zod schemas the
 * shell adapter applies at runtime. This pins the jq transform (status mapping,
 * label decoding, ADF flattening, URL synthesis) that `list` and `get` share.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { snapshotEnvironmentVariables } from "../../../testHelpers/env.ts";
import { shellFetchOutputSchema, shellIssueSchema } from "./schema.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const SCRIPT = path.join(REPO_ROOT, "examples/jira/jira.sh");

/** One JIRA Cloud REST issue, trimmed to the fields the transform reads. */
function issue(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "10000",
    key: "ENG-0",
    self: "https://acme.atlassian.net/rest/api/3/issue/10000",
    fields: {
      summary: "Summary",
      description: "Body",
      status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
      labels: [],
      assignee: { displayName: "Alice" },
      updated: "2026-05-22T15:00:00.000+0000",
    },
    ...overrides,
  };
}

const LIST_FIXTURE = {
  issues: [
    issue({
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
      },
    }),
    issue({
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
    }),
    issue({
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
    }),
    issue({
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
    }),
  ],
};

interface Harness {
  dir: string;
  tokenFile: string;
  listFixture: string;
  getFixture: string;
  cleanup: () => void;
}

function setup(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "jira-example-"));
  const tokenFile = path.join(dir, "jira.token");
  writeFileSync(tokenFile, "fake-token");

  const listFixture = path.join(dir, "list.json");
  const getFixture = path.join(dir, "get.json");
  writeFileSync(listFixture, JSON.stringify(LIST_FIXTURE));

  // Fake `jira` CLI: dispatches on the subcommand and echoes fixtures.
  const fakeJira = path.join(dir, "jira");
  writeFileSync(
    fakeJira,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "me" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "issue" && "${2:-}" == "list" ]]; then cat "$FIXTURE_LIST"; exit 0; fi',
      'if [[ "${1:-}" == "issue" && "${2:-}" == "view" ]]; then',
      '  if [[ "${3:-}" == MISSING* ]]; then exit 1; fi',
      '  cat "$FIXTURE_GET"; exit 0',
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
    listFixture,
    getFixture,
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
      FIXTURE_GET: h.getFixture,
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

  it("get emits one ShellIssue for a known key", () => {
    writeFileSync(h.getFixture, JSON.stringify(LIST_FIXTURE.issues[0]));
    const { status, stdout } = run(h, ["get", "ENG-1"]);
    expect(status).toBe(0);

    const parsed = shellIssueSchema.parse(JSON.parse(stdout));
    expect(parsed.id).toBe("ENG-1");
    expect(parsed.repository).toBe("ClipboardHealth/api");
  });

  it("get exits 3 (not-found sentinel) when jira cannot find the key", () => {
    expect(run(h, ["get", "MISSING-9"]).status).toBe(3);
  });

  it("verify exits 0 when the token file is present", () => {
    expect(run(h, ["verify"]).status).toBe(0);
  });
});
