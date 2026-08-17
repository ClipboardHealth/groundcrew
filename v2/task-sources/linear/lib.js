const TASK_FIELDS = `
  id identifier title description priority
  state { id name type }
  labels { nodes { name } }
  children { nodes { id state { type } } }
  relations { nodes { type relatedIssue { id state { type } } } }
  inverseRelations { nodes { type issue { id state { type } } } }
`;

const ISSUE_FIELDS = `
  ${TASK_FIELDS}
  team { states { nodes { id name type } } }
  comments { nodes { body createdAt } }
`;

const LIST_STATE_TYPES = ["unstarted", "started", "completed", "canceled", "duplicate"];

export async function run(input) {
  try {
    const payload = await readStandardInput();
    const data =
      input.command === "list"
        ? await listTasks()
        : input.command === "get"
          ? await getTask(payload)
          : await updateTask(payload);
    process.stdout.write(`${JSON.stringify({ data, ok: true })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: { message: errorMessage(error) }, ok: false })}\n`,
    );
  }
}

function errorMessage(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  if (!(cause instanceof Error)) {
    return error.message;
  }
  const code = "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
  return `${error.message}: ${cause.message}${code}`;
}

async function listTasks() {
  const issues = [];
  const agentLabelPrefix = environment("LINEAR_GROUNDCREW_LABEL_PREFIX", "agent-");
  let after;
  for (;;) {
    const data = await graphql({
      operationName: "GroundcrewList",
      query: `query GroundcrewList($after: String, $stateTypes: [String!]!, $agentLabelPrefix: String!) {
        issues(
          filter: {
            assignee: { isMe: { eq: true } }
            state: { type: { in: $stateTypes } }
            labels: { some: { name: { startsWith: $agentLabelPrefix } } }
          }
          first: 250
          after: $after
          includeArchived: false
        ) {
          nodes { ${TASK_FIELDS} }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables: { after, agentLabelPrefix, stateTypes: LIST_STATE_TYPES },
    });
    const page = data.issues;
    issues.push(...(page?.nodes ?? []));
    if (page?.pageInfo?.hasNextPage !== true) {
      break;
    }
    if (!page.pageInfo.endCursor) {
      throw new Error("Linear returned another issue page without an end cursor");
    }
    after = page.pageInfo.endCursor;
  }
  return { tasks: issues.map(normalizeIssue).filter((task) => task !== undefined) };
}

async function getTask(input) {
  const issue = await loadIssue(input.id);
  const task = normalizeIssue(issue);
  if (task === undefined) {
    throw new Error(`Linear issue ${input.id} is not opted in with an agent label`);
  }
  return { task };
}

async function updateTask(input) {
  const issue = await loadIssue(input.id);
  if (input.event.type === "claimed") {
    const task = normalizeIssue(issue);
    if (task === undefined || task.terminal || task.blocked) {
      return { reason: "issue is no longer dispatchable", result: "rejected" };
    }
    const marker = `[groundcrew:${input.event.runId}:claimed]`;
    await addCommentOnce({ issue, marker, text: `${marker}\nClaimed by Groundcrew.` });
    await moveIssue({ issue, stateName: environment("LINEAR_STATUS_IN_PROGRESS", "In Progress") });
    return { result: "ok" };
  }
  if (input.event.type === "continued") {
    const task = normalizeIssue(issue);
    if (task === undefined || task.terminal) {
      return { reason: "issue is no longer continuable", result: "rejected" };
    }
    const marker = `[groundcrew:${input.event.runId}:claimed]`;
    await addCommentOnce({
      issue,
      marker,
      text: `${marker}\nContinued by Groundcrew from ${input.event.previousRunId}.`,
    });
    await moveIssue({ issue, stateName: environment("LINEAR_STATUS_IN_PROGRESS", "In Progress") });
    return { result: "ok" };
  }
  const artifactLines = input.event.artifacts.map(
    (artifact) =>
      `- ${artifact.kind}: ${artifact.locator}${artifact.title ? ` — ${artifact.title}` : ""}`,
  );
  const completionRunId = input.event.runId ?? latestClaimRunId(issue);
  const completionMarker = `[groundcrew:${completionRunId ?? "unclaimed"}:completed:${input.event.outcome}]`;
  const text = [
    completionMarker,
    `Groundcrew completed this run as ${input.event.outcome}.`,
    input.event.message,
    artifactLines.length > 0 ? `Artifacts:\n${artifactLines.join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  await addCommentOnce({ issue, marker: completionMarker, text });
  if (["completed", "canceled", "duplicate"].includes(issue.state?.type)) {
    return { result: "ok" };
  }
  if (input.event.outcome === "delivered") {
    await moveIssue({
      allowMissing: true,
      issue,
      stateName: environment("LINEAR_STATUS_IN_REVIEW", "In Review"),
    });
  } else if (input.event.outcome === "failed") {
    await moveIssue({ issue, stateName: environment("LINEAR_STATUS_TODO", "Todo") });
  }
  return { result: "ok" };
}

function latestClaimRunId(issue) {
  let latest;
  for (const comment of issue.comments?.nodes ?? []) {
    const match = comment.body.match(/\[groundcrew:(r_[0-9a-f]{8}):claimed\]/);
    if (!match) {
      continue;
    }
    const timestamp = Date.parse(comment.createdAt ?? "");
    if (Number.isNaN(timestamp)) {
      continue;
    }
    if (latest === undefined || timestamp > latest.timestamp) {
      latest = { runId: match[1], timestamp };
    }
  }
  return latest?.runId;
}

async function loadIssue(id) {
  const data = await graphql({
    operationName: "GroundcrewIssue",
    query: `query GroundcrewIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    variables: { id },
  });
  if (!data.issue) {
    throw new Error(`Linear issue ${id} was not found`);
  }
  return data.issue;
}

function normalizeIssue(issue) {
  const labelPrefix = environment("LINEAR_GROUNDCREW_LABEL_PREFIX", "agent-");
  const agentLabel = issue.labels?.nodes?.find((label) => label.name.startsWith(labelPrefix));
  if (!agentLabel) {
    return undefined;
  }
  const stateType = issue.state?.type;
  if (stateType === "backlog" || stateType === "triage") {
    return undefined;
  }
  const terminal = ["completed", "canceled", "duplicate"].includes(stateType);
  const blockers = [
    ...(issue.relations?.nodes ?? []).filter((relation) => relation.type === "blockedBy"),
    ...(issue.inverseRelations?.nodes ?? []).filter((relation) => relation.type === "blocks"),
  ];
  const hasOpenBlocker = blockers.some((relation) => {
    const related = relation.relatedIssue ?? relation.issue;
    return !["completed", "canceled", "duplicate"].includes(related?.state?.type);
  });
  const hasChildren = (issue.children?.nodes?.length ?? 0) > 0;
  return {
    agentProfile: agentLabel.name.slice(labelPrefix.length),
    blocked: !terminal && (stateType !== "unstarted" || hasOpenBlocker || hasChildren),
    description: issue.description ?? undefined,
    id: issue.identifier,
    priority: issue.priority === 0 ? undefined : issue.priority,
    repositories: parseRepositories(issue.description ?? ""),
    terminal,
    title: issue.title,
  };
}

function parseRepositories(description) {
  const match = description.match(/^Repositor(?:y|ies):\s*(.+)$/im);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/[,\s]+/)
    .map((repository) => repository.replaceAll(/[`*_]/g, "").trim())
    .filter(Boolean);
}

async function addCommentOnce(input) {
  if (input.issue.comments?.nodes?.some((comment) => comment.body.includes(input.marker))) {
    return;
  }
  await graphql({
    operationName: "GroundcrewComment",
    query: `mutation GroundcrewComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    variables: { input: { body: input.text, issueId: input.issue.id } },
  });
}

async function moveIssue(input) {
  if (input.issue.state?.name === input.stateName) {
    return;
  }
  const state = input.issue.team?.states?.nodes?.find(
    (candidate) => candidate.name === input.stateName,
  );
  if (!state) {
    if (input.allowMissing === true) {
      return;
    }
    throw new Error(`Linear workflow state '${input.stateName}' was not found`);
  }
  await graphql({
    operationName: "GroundcrewMove",
    query: `mutation GroundcrewMove($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    variables: { id: input.issue.id, input: { stateId: state.id } },
  });
}

async function graphql(input) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required");
  }
  const response = await fetch(environment("LINEAR_API_URL", "https://api.linear.app/graphql"), {
    body: JSON.stringify(input),
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Linear API returned HTTP ${response.status}`);
  }
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.data;
}

async function readStandardInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return JSON.parse(raw);
}

function environment(name, fallback) {
  return process.env[name] || fallback;
}
