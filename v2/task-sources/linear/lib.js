"use strict";

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions, typescript/no-require-imports, no-implicit-globals, unicorn/no-process-exit, node/no-process-env, typescript/prefer-nullish-coalescing, unicorn/no-useless-undefined -- This bundle is a language-agnostic CommonJS node-shebang protocol script (contracts §4): builtins-only `require`, module-scoped function declarations, `process.exit` for deterministic protocol exit codes, and `process.env` for the config the boundary hands in. It is untyped JS, so the type-aware `no-unsafe-*`/strict-boolean rules have nothing to check. The `||`/`|| undefined` env reads in `config()` intentionally treat an empty string as "unset → default", which `??` (prefer-nullish-coalescing) and no-useless-undefined would break. */

// linear source bundle — protocol v1 (contracts §4).
//
// Talks to Linear's GraphQL API over https using node's global `fetch` (node
// builtins only — no @linear/sdk). Reads the viewer's assigned, non-terminal
// issues; writes back as issue comments (state moves are the tracker's job by
// default, with an opt-in target state).
//
// Env surface (see README.md):
//   LINEAR_API_KEY          (secret, required) — sent as the Authorization header
//   LINEAR_API_URL          GraphQL endpoint; default https://api.linear.app/graphql
//                           (override for self-hosted proxies and tests)
//   LINEAR_GROUNDCREW_LABEL optional issue-label name to filter the queue
//   LINEAR_STATUS_IN_PROGRESS  comma-separated candidate names for the
//                           in-progress column (default "In Progress")
//   LINEAR_STATUS_IN_REVIEW    comma-separated candidate names for the
//                           in-review column (default "In Review")
//   LINEAR_COMPLETED_STATE_ID  optional workflow state id; when set, it OVERRIDES
//                           the in-review resolution — a delivered completion
//                           moves the issue straight to that exact state instead

const fs = require("node:fs");

const DEFAULT_API_URL = "https://api.linear.app/graphql";
// v1's status resolution (src/lib/adapters/linear/statusNames.ts:16-19): Linear's
// default workflow has MULTIPLE `started`-type states — both "In Progress" and
// "In Review" are `started`. Name-match wins; in-progress falls back to the
// lowest-position started column, in-review has no fallback.
const DEFAULT_IN_PROGRESS_NAMES = ["In Progress"];
const DEFAULT_IN_REVIEW_NAMES = ["In Review"];
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);
const REPOS_LINE = /^Repos:\s*(.+)$/im;
// v1's ticket convention (and the team's ticket-creation tooling) writes a
// singular `Repository: <name>` line; existing boards are full of it. It is
// an explicit designation, so honoring it does not resurrect v1's ratified-
// dead prose inference (design §4). `Repos:` wins when both are present.
const REPOSITORY_LINE = /^Repository:\s*(.+)$/im;
const AGENT_LINE = /^Agent:\s*(\S+)/im;

function config() {
  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("LINEAR_API_KEY is not set");
  }
  return {
    apiKey,
    apiUrl: process.env["LINEAR_API_URL"] || DEFAULT_API_URL,
    label: process.env["LINEAR_GROUNDCREW_LABEL"] || undefined,
    labelPrefix: process.env["LINEAR_GROUNDCREW_LABEL_PREFIX"] || "agent-",
    completedStateId: process.env["LINEAR_COMPLETED_STATE_ID"] || undefined,
    inProgressNames: parseStatusNames(
      process.env["LINEAR_STATUS_IN_PROGRESS"],
      DEFAULT_IN_PROGRESS_NAMES,
    ),
    inReviewNames: parseStatusNames(process.env["LINEAR_STATUS_IN_REVIEW"], DEFAULT_IN_REVIEW_NAMES),
    timeoutMs: Number(process.env["LINEAR_HTTP_TIMEOUT_MS"]) || 20000,
  };
}

function parseStatusNames(raw, fallback) {
  if (!raw || raw.trim() === "") {
    return fallback;
  }
  const names = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return names.length > 0 ? names : fallback;
}

async function graphql(query, variables) {
  const { apiKey, apiUrl, timeoutMs } = config();
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Linear API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Linear API returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (payload.errors) {
    throw new Error(
      `Linear API error: ${payload.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return payload.data;
}

// Linear priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low.
// Protocol: higher number dispatches first, so Urgent must be the largest.
// Urgent→4, High→3, Medium→2, Low→1; None → omitted (no ordering signal).
function priorityToProtocol(linearPriority) {
  if (!linearPriority || linearPriority < 1 || linearPriority > 4) {
    return undefined;
  }
  return 5 - linearPriority;
}

function isTerminalStateType(stateType) {
  return stateType !== undefined && TERMINAL_STATE_TYPES.has(stateType);
}

function parseRepos(description) {
  const match = description
    ? (REPOS_LINE.exec(description) ?? REPOSITORY_LINE.exec(description))
    : null;
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((value) => repoDirectoryName(value.trim()))
    .filter(Boolean);
}

// Accept `owner/repo` forms by keeping the directory basename — the repo
// universe is directory names under workspace.baseDirectory (design §4).
// Tickets routinely wrap the name in markdown (`repo`, **repo**), so
// formatting characters are stripped first (v1's word-boundary regex was
// naturally immune; found live via a "cbh-mobile-app\`" skip detail).
function repoDirectoryName(value) {
  const stripped = value.replaceAll(/^[`*_\s]+|[`*_\s.,;]+$/g, "");
  const slash = stripped.lastIndexOf("/");
  return slash === -1 ? stripped : stripped.slice(slash + 1);
}

function parseAgent(description) {
  const match = description ? AGENT_LINE.exec(description) : null;
  return match ? match[1] : undefined;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  state { type name }
  labels(first: 20) { nodes { name } }
  children(first: 1, includeArchived: false) { nodes { id } }
  inverseRelations(first: 50, includeArchived: false) {
    nodes { type issue { identifier state { type } } }
  }
`;

function agentFromLabels(labels) {
  const { labelPrefix } = config();
  const match = (labels ?? []).find(
    (label) => typeof label?.name === "string" && label.name.startsWith(labelPrefix),
  );
  const agent = match?.name.slice(labelPrefix.length);
  return agent ? agent : undefined;
}

function taskFromNode(node) {
  const description = node.description ?? undefined;
  const blockers = (node.inverseRelations?.nodes ?? []).filter(
    (relation) =>
      relation.type === "blocks" && !isTerminalStateType(relation.issue?.state?.type),
  );
  const repos = parseRepos(description);
  const agent = agentFromLabels(node.labels?.nodes) ?? parseAgent(description);
  const priority = priorityToProtocol(node.priority);
  // v1 parity: only Todo (state.type "unstarted") is dispatchable; anything
  // else is surfaced but ineligible, exactly like an open blocker.
  const dispatchable = node.state?.type === "unstarted";
  // v1 parity (src/lib/adapters/linear/fetch.ts:265-276): an issue with children
  // is a parent/epic and is never dispatched — v1 excluded it from the issues
  // list entirely and only recorded it as a diagnostic `parentSkip`. v2 has a
  // single tasks channel, so we surface it `blocked` instead of dropping it: the
  // epic stays visible (and reapable when terminal) but is never a dispatch target.
  const hasChildren = (node.children?.nodes ?? []).length > 0;

  const terminal = isTerminalStateType(node.state?.type);
  const task = {
    id: node.identifier,
    title: node.title,
    terminal,
  };
  if (description !== undefined) {
    task.description = description;
  }
  if (priority !== undefined) {
    task.priority = priority;
  }
  if (blockers.length > 0 || (!terminal && (!dispatchable || hasChildren))) {
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
  const { label, labelPrefix } = config();
  // v1 parity (src/lib/adapters/linear/fetch.ts): dispatch is OPT-IN via the
  // `agent-*` label; only viewer-assigned, labelled issues surface. Terminal
  // states stay listed (the reap sweep observes them); backlog/triage never do.
  const filter = {
    assignee: { isMe: { eq: true } },
    labels: { some: { name: { startsWith: labelPrefix } } },
    state: { type: { nin: ["backlog", "triage"] } },
  };
  if (label) {
    filter.and = [{ labels: { some: { name: { eq: label } } } }];
  }

  const tasks = [];
  let after = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- cursor depends on the prior page
    const data = await graphql(
      `query ListIssues($filter: IssueFilter, $after: String) {
        issues(filter: $filter, first: 50, after: $after, includeArchived: false) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after },
    );
    const page = data.issues;
    for (const node of page.nodes) {
      tasks.push(taskFromNode(node));
    }
    if (!page.pageInfo.hasNextPage) {
      break;
    }
    after = page.pageInfo.endCursor;
  }
  return { tasks };
}

function parseIdentifier(id) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(id ?? ""));
  if (!match) {
    throw new Error(`not a Linear issue identifier: ${String(id)}`);
  }
  return { key: match[1].toUpperCase(), number: Number(match[2]) };
}

async function fetchNodeByIdentifier(id) {
  const { key, number } = parseIdentifier(id);
  const data = await graphql(
    `query GetIssue($key: String!, $number: Float!) {
      issues(filter: { team: { key: { eq: $key } }, number: { eq: $number } }, first: 1) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    { key, number },
  );
  const node = data.issues.nodes[0];
  if (!node) {
    throw new Error(`Linear issue ${String(id)} not found`);
  }
  return node;
}

async function getTask(input) {
  const node = await fetchNodeByIdentifier(input?.id);
  return { task: taskFromNode(node) };
}

async function comment(issueId, body) {
  await graphql(
    `mutation Comment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body },
  );
}

async function moveToState(issueId, stateId) {
  await graphql(
    `mutation Move($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId },
  );
}

// The `started`-type workflow states for a team, resolved by team key (the
// left-hand side of an issue identifier, e.g. DEVOP in DEVOP-123). v1 fetched
// per transition and never negatively cached a missing state (writeback.ts:29-41);
// each `update` is a fresh short-lived process, so a single fetch per invocation
// is that same posture with nothing to cache.
async function fetchStartedStates(teamKey) {
  const data = await graphql(
    `query TeamStates($key: String!) {
      workflowStates(filter: { team: { key: { eq: $key } } }, first: 100) {
        nodes { id name type position }
      }
    }`,
    { key: teamKey },
  );
  return (data.workflowStates?.nodes ?? []).filter((state) => state.type === "started");
}

function normalizeStatusName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function findStateByName(states, names) {
  const wanted = new Set(names.map(normalizeStatusName));
  return states.find((state) => wanted.has(normalizeStatusName(state.name)));
}

// In-progress: name-match over started states, else the lowest-position
// (leftmost) started column (statusNames.ts:64-66 / writeback.ts:63-66).
function resolveInProgressStateId(startedStates, names) {
  const named = findStateByName(startedStates, names);
  if (named) {
    return named.id;
  }
  return startedStates.toSorted((a, b) => a.position - b.position).at(0)?.id;
}

// In-review: name-match only — NO position fallback. v1's getInReviewStateId
// returns undefined when unmatched and markInReview reports `unsupported`
// (writeback.ts:74-90); under this bundle's soft posture that is a skipped move.
function resolveInReviewStateId(startedStates, names) {
  return findStateByName(startedStates, names)?.id;
}

function warnTransition(message) {
  process.stderr.write(`groundcrew(linear): ${message}\n`);
}

// Soft posture: a state-move failure is logged to stderr and swallowed so the
// comment writeback is never lost — mirroring v1's reviewer, which logs and
// swallows writeback errors and retries next tick (src/commands/reviewer.ts:209-211).
async function transitionToStarted(node, teamKey, kind) {
  const { inProgressNames, inReviewNames } = config();
  let startedStates;
  try {
    startedStates = await fetchStartedStates(teamKey);
  } catch (error) {
    warnTransition(
      `could not fetch workflow states for team ${teamKey}: ${error?.message ?? String(error)}`,
    );
    return;
  }
  const stateId =
    kind === "in-progress"
      ? resolveInProgressStateId(startedStates, inProgressNames)
      : resolveInReviewStateId(startedStates, inReviewNames);
  if (!stateId) {
    warnTransition(
      `no "${kind}" workflow state for team ${teamKey}; leaving ${node.identifier} unchanged`,
    );
    return;
  }
  await softMove(node, stateId, kind);
}

async function softMove(node, stateId, label) {
  try {
    await moveToState(node.id, stateId);
  } catch (error) {
    warnTransition(`failed to move ${node.identifier} to ${label}: ${error?.message ?? String(error)}`);
  }
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
  const node = await fetchNodeByIdentifier(input?.id);
  const { key: teamKey } = parseIdentifier(node.identifier);

  if (event.type === "claimed") {
    // Comment first, then move state: the comment is the primary writeback and a
    // state-move failure must never lose it (soft posture). v1's dispatcher moved
    // the ticket to In Progress at exactly this moment (src/commands/dispatcher.ts:151).
    await comment(node.id, `Groundcrew claimed this task${event.runId ? ` (run ${event.runId})` : ""}.`);
    await transitionToStarted(node, teamKey, "in-progress");
    // This source never arbitrates contention, so a claim is always ok.
    return { result: "ok" };
  }
  if (event.type === "progress") {
    await comment(node.id, `Groundcrew progress: ${event.note ?? ""}`.trim());
    return { result: "ok" };
  }
  if (event.type === "completed") {
    await comment(node.id, completionBody(event));
    // delivered ≙ v1's reviewer moving an in-progress task to In Review once an
    // open PR existed (src/commands/reviewer.ts:78-89, 224): the agent reports
    // `delivered` with its PR artifacts at that same moment. failed/stopped: v1
    // left the ticket In Progress — no board caller reverts it to Todo (reap/
    // runStateCleanup do no writeback) — so we post the comment only.
    if (event.outcome === "delivered") {
      const { completedStateId } = config();
      if (completedStateId) {
        // Explicit operator override: send delivered straight to this exact
        // state id (e.g. Done), bypassing in-review resolution. Still soft.
        await softMove(node, completedStateId, "completed");
      } else {
        await transitionToStarted(node, teamKey, "in-review");
      }
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
  // Exit only once the write has flushed: `process.exit` right after a large
  // `stdout.write` truncates at the 64KB pipe buffer when stdout is a pipe
  // (which it always is under groundcrew). Found live with a 274KB list.
  process.stdout.write(JSON.stringify(object) + "\n", () => {
    process.exit(0);
  });
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
};
