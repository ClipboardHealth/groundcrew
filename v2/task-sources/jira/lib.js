"use strict";

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions, typescript/no-require-imports, no-implicit-globals, unicorn/no-process-exit, node/no-process-env, typescript/prefer-nullish-coalescing -- This bundle is a language-agnostic CommonJS node-shebang protocol script (contracts §4): builtins-only `require`, module-scoped function declarations, `process.exit` for deterministic protocol exit codes, and `process.env` for the config the boundary hands in. It is untyped JS, so the type-aware `no-unsafe-*`/strict-boolean rules have nothing to check. The `||` env reads in `config()` intentionally treat an empty string as "unset → default", which `??` (prefer-nullish-coalescing) would break. */

// jira source bundle — protocol v1 (contracts §4).
//
// Talks to Jira Cloud's REST API v3 over https using node's global `fetch` (node
// builtins only — no SDK). Lists the issues matching a configurable JQL query,
// and writes back as issue comments (Atlassian Document Format). State moves are
// left to Jira's own automation by default, with an opt-in "done" transition.
//
// Env surface (see README.md):
//   JIRA_EMAIL             (secret, required) — Atlassian account email (Basic auth user)
//   JIRA_API_TOKEN         (secret, required) — Atlassian API token (Basic auth password)
//   JIRA_BASE_URL          (required) site root, e.g. https://your-domain.atlassian.net
//                          (override for tests to point at a local fake)
//   JIRA_GROUNDCREW_JQL    the queue query; default below
//   JIRA_DONE_TRANSITION_ID  optional transition id; when set, a delivered
//                          completion also transitions the issue there

const fs = require("node:fs");

const DEFAULT_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created ASC";
// Jira priority names → protocol number (higher dispatches first).
const PRIORITY_BY_NAME = { highest: 5, high: 4, medium: 3, low: 2, lowest: 1 };
const ISSUE_FIELDS = ["summary", "description", "priority", "status", "issuelinks"];
const REPOS_LINE = /^Repos:\s*(.+)$/im;
const AGENT_LINE = /^Agent:\s*(\S+)/im;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function config() {
  const email = requireEnv("JIRA_EMAIL");
  const token = requireEnv("JIRA_API_TOKEN");
  const baseUrl = requireEnv("JIRA_BASE_URL").replace(/\/+$/, "");
  return {
    baseUrl,
    authHeader: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    jql: process.env["JIRA_GROUNDCREW_JQL"] || DEFAULT_JQL,
    doneTransitionId: process.env["JIRA_DONE_TRANSITION_ID"] || undefined,
    timeoutMs: Number(process.env["JIRA_HTTP_TIMEOUT_MS"]) || 20000,
  };
}

async function jiraFetch(method, path, body, options) {
  const { baseUrl, authHeader, timeoutMs } = config();
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: authHeader,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  if (response.status === 404 && options && options.notFoundAsNull) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Jira API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Jira API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// Atlassian Document Format is a rich JSON tree; flatten it to plain text so the
// `Repos:`/`Agent:` lines are parseable. Block nodes end a line.
function adfToText(node) {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (node.type === "text") {
    return node.text || "";
  }
  if (node.type === "hardBreak") {
    return "\n";
  }
  const children = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  const isBlock =
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "blockquote" ||
    node.type === "listItem";
  return isBlock ? `${children}\n` : children;
}

function priorityToProtocol(priorityField) {
  const name = priorityField && priorityField.name ? priorityField.name.toLowerCase() : undefined;
  return name && name in PRIORITY_BY_NAME ? PRIORITY_BY_NAME[name] : undefined;
}

function isTerminalStatus(statusField) {
  const key = statusField && statusField.statusCategory ? statusField.statusCategory.key : undefined;
  return key === "done";
}

function isBlocked(issueLinks) {
  return (issueLinks || []).some((link) => {
    const inward = link.type && link.type.inward ? link.type.inward.toLowerCase() : "";
    const blocker = link.inwardIssue;
    return (
      Boolean(blocker) && inward.includes("blocked by") && !isTerminalStatus(blocker.fields?.status)
    );
  });
}

function parseLine(regex, text) {
  const match = text ? regex.exec(text) : null;
  return match ? match[1] : undefined;
}

function taskFromNode(issue) {
  const fields = issue.fields || {};
  const descriptionText = adfToText(fields.description).trim();
  const repos = (parseLine(REPOS_LINE, descriptionText) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const agent = parseLine(AGENT_LINE, descriptionText);
  const priority = priorityToProtocol(fields.priority);

  const task = {
    id: issue.key,
    title: fields.summary || "",
    terminal: isTerminalStatus(fields.status),
  };
  if (descriptionText !== "") {
    task.description = descriptionText;
  }
  if (priority !== undefined) {
    task.priority = priority;
  }
  if (isBlocked(fields.issuelinks)) {
    task.blocked = true;
  }
  if (agent !== undefined) {
    task.agent = agent;
  }
  if (repos.length > 0) {
    task.repos = repos;
  }
  return task;
}

async function listTasks() {
  const { jql } = config();
  const tasks = [];
  let nextPageToken;
  for (;;) {
    const body = { jql, maxResults: 100, fields: ISSUE_FIELDS };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }
    // eslint-disable-next-line no-await-in-loop -- cursor pagination depends on the prior page
    const data = await jiraFetch("POST", "/rest/api/3/search/jql", body);
    for (const issue of data.issues || []) {
      tasks.push(taskFromNode(issue));
    }
    if (!data.nextPageToken) {
      break;
    }
    nextPageToken = data.nextPageToken;
  }
  return { tasks };
}

async function getTask(input) {
  const id = input?.id;
  if (id === undefined) {
    throw new Error("get requires an `id`");
  }
  const key = encodeURIComponent(String(id));
  const issue = await jiraFetch(
    "GET",
    `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS.join(",")}`,
    undefined,
    { notFoundAsNull: true },
  );
  if (!issue) {
    throw new Error(`Jira issue ${String(id)} not found`);
  }
  return { task: taskFromNode(issue) };
}

function textToAdf(text) {
  const content = text.split("\n").map((line) => ({
    type: "paragraph",
    content: line === "" ? [] : [{ type: "text", text: line }],
  }));
  return { type: "doc", version: 1, content };
}

async function comment(key, text) {
  await jiraFetch("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    body: textToAdf(text),
  });
}

async function transitionTo(key, transitionId) {
  await jiraFetch("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    transition: { id: transitionId },
  });
}

function completionBody(event) {
  const lines = [`Groundcrew completed this task (outcome: **${event.outcome}**).`];
  if (event.message) {
    lines.push("", event.message);
  }
  const artifacts = event.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push("", "Artifacts:");
    for (const artifact of artifacts) {
      const title = artifact.title ? `${artifact.title} — ` : "";
      const kind = artifact.kind ? `${artifact.kind}: ` : "";
      lines.push(`- ${kind}${title}${artifact.locator}`);
    }
  }
  return lines.join("\n");
}

async function applyUpdate(input) {
  const event = input?.event ?? {};
  const id = input?.id;
  if (id === undefined) {
    throw new Error("update requires an `id`");
  }
  const key = String(id);

  if (event.type === "claimed") {
    await comment(key, `Groundcrew claimed this task${event.runId ? ` (run ${event.runId})` : ""}.`);
    // Comment-only source: it never arbitrates contention, so a claim is always ok.
    return { result: "ok" };
  }
  if (event.type === "progress") {
    await comment(key, `Groundcrew progress: ${event.note ?? ""}`.trim());
    return { result: "ok" };
  }
  if (event.type === "completed") {
    await comment(key, completionBody(event));
    const { doneTransitionId } = config();
    if (event.outcome === "delivered" && doneTransitionId) {
      await transitionTo(key, doneTransitionId);
    }
    return { result: "ok" };
  }
  return { result: "ok" };
}

// --- protocol plumbing (contracts §4.2) ---

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return {};
  }
}

function emit(object) {
  process.stdout.write(JSON.stringify(object) + "\n");
  process.exit(0);
}

async function run(handler) {
  try {
    const data = await handler(readStdin());
    emit({ ok: true, data });
  } catch (error) {
    emit({ ok: false, error: { message: error?.message ?? String(error) } });
  }
}

module.exports = {
  run,
  listTasks,
  getTask,
  applyUpdate,
  priorityToProtocol,
  taskFromNode,
  adfToText,
};
