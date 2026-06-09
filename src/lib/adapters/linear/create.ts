import { readFileSync } from "node:fs";

import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "../../config.ts";
import type { CreateTaskInput } from "../../taskSource.ts";
import { fetchResolvedIssue, type Issue as LinearIssue } from "./fetch.ts";
import { AGENT_LABEL_PREFIX, resolveRepositoryFor } from "./parsing.ts";
import type { LinearAdapterConfig } from "./schema.ts";
import { findLinearWorkflowStateByName, type LinearWorkflowState } from "./statusNames.ts";

const TODO_STATE_NAMES = ["Todo", "To Do"] as const;

interface CreateLinearIssueArguments {
  client: LinearClient;
  config: ResolvedConfig;
  input: CreateTaskInput;
  sourceConfig: LinearAdapterConfig;
  sourceName: string;
}

interface LinearCreateContext {
  viewer: { id: string; name: string } | null;
  teams: {
    nodes: {
      id: string;
      key: string;
      name: string;
      labels: { nodes: { id: string; name: string }[] };
      states: { nodes: LinearWorkflowState[] };
    }[];
  };
}

interface CreateIssueResponse {
  issueCreate: {
    success: boolean;
    issue: { identifier: string } | null;
  };
}

interface CreateIssueRelationResponse {
  issueRelationCreate: {
    success: boolean;
  };
}

export async function createLinearIssue(
  arguments_: CreateLinearIssueArguments,
): Promise<LinearIssue> {
  const { client, config, input, sourceConfig, sourceName } = arguments_;
  assertSupportedCreateInput(input);

  const title = normalizeTitle(input.title);
  const repository = resolveCreateRepository({ config, input });
  const teamSelector = resolveTeamSelector({ input, sourceConfig });
  const agentLabelName = resolveAgentLabelName(input.agent);
  const priority = linearPriority(input.priority);
  const description = buildLinearDescription({ input, repository, title });
  const context = await fetchCreateContext({ client, teamSelector, agentLabelName });
  const team = requireExactlyOne(context.teams.nodes, `Linear team "${teamSelector}"`);
  const todoState = requireTodoState(team.states.nodes, team.key);
  const agentLabel = requireExactlyOne(team.labels.nodes, `Linear label "${agentLabelName}"`);
  if (context.viewer === null) {
    throw new Error("Linear API did not return a viewer for this API key.");
  }

  const createdIdentifier = await createIssue({
    client,
    assigneeId: context.viewer.id,
    description,
    dueDate: input.due,
    labelId: agentLabel.id,
    priority,
    stateId: todoState.id,
    teamId: team.id,
    title,
  });

  for (const dependency of input.dependencies) {
    // oxlint-disable-next-line no-await-in-loop -- relation creation targets the issue created above and should fail fast in input order
    await createBlockedByRelation({
      client,
      dependency,
      relatedIssueId: createdIdentifier,
      sourceName,
    });
  }

  const resolved = await fetchResolvedIssue({ client, config, task: createdIdentifier });
  return {
    id: createdIdentifier.toLowerCase(),
    uuid: resolved.uuid,
    title: resolved.title,
    description: resolved.description,
    status: resolved.status,
    statusId: resolved.statusId,
    stateType: resolved.stateType,
    assignee: resolved.assignee,
    updatedAt: resolved.updatedAt,
    repository: resolved.repository,
    agent: resolved.agent,
    teamId: resolved.teamId,
    blockers: resolved.blockers,
    hasMoreBlockers: resolved.hasMoreBlockers,
    url: resolved.url,
    priority: resolved.priority,
  };
}

function assertSupportedCreateInput(input: CreateTaskInput): void {
  if (input.id !== undefined) {
    throw new Error("linear: --id is not supported; Linear assigns issue identifiers");
  }
  if (input.recurrence !== undefined) {
    throw new Error("linear: --rec is not supported");
  }
  if (input.edit) {
    throw new Error("linear: --edit is not supported");
  }
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new Error("linear: title is required");
  }
  if (/[\r\n]/.test(normalized)) {
    throw new Error("linear: title must be a single line");
  }
  return normalized;
}

function resolveCreateRepository(arguments_: {
  config: ResolvedConfig;
  input: CreateTaskInput;
}): string {
  const { config, input } = arguments_;
  if (input.repository === undefined) {
    throw new Error("linear: --repo is required so Groundcrew can route the task");
  }
  const resolution = resolveRepositoryFor({
    description: `Repository: ${input.repository}`,
    config,
  });
  if (resolution.kind === "missing") {
    throw new Error(
      `linear: repository "${input.repository}" is not in workspace.knownRepositories`,
    );
  }
  return resolution.repository;
}

function resolveTeamSelector(arguments_: {
  input: CreateTaskInput;
  sourceConfig: LinearAdapterConfig;
}): string {
  const { input, sourceConfig } = arguments_;
  const selector = input.team ?? sourceConfig.team;
  if (selector === undefined) {
    throw new Error(
      'linear: team is required. Pass --team <key-or-id> or configure sources: [{ kind: "linear", team: "<key-or-id>" }].',
    );
  }
  const normalized = selector.trim();
  if (normalized.length === 0) {
    throw new Error("linear: team must be a non-empty string");
  }
  return normalized;
}

function resolveAgentLabelName(agent: string): string {
  const normalized = agent.trim();
  if (normalized.length === 0) {
    throw new Error("linear: --agent must be a non-empty string");
  }
  return `${AGENT_LABEL_PREFIX}${normalized}`;
}

function linearPriority(priority: string | undefined): number | undefined {
  if (priority === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(priority, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== priority || parsed < 0 || parsed > 4) {
    throw new Error("linear: --priority must be an integer from 0 to 4");
  }
  return parsed;
}

function buildLinearDescription(arguments_: {
  input: CreateTaskInput;
  repository: string;
  title: string;
}): string {
  const { input, repository, title } = arguments_;
  return [
    "## Groundcrew",
    "",
    `Repository: ${repository}`,
    "Implementation workflow: use the `core:go`/`go` skill when available. If that skill is unavailable, follow this repo's AGENTS.md/CLAUDE.md implementation workflow and run the documented verification.",
    "",
    "## Task",
    "",
    promptBody(input, title),
    "",
    "## Acceptance Criteria",
    "",
    `- [ ] ${title}`,
    "",
    "## Notes",
    "",
    notesFor(input),
  ].join("\n");
}

function promptBody(input: CreateTaskInput, fallbackTitle: string): string {
  if (input.promptFile !== undefined && input.description !== undefined) {
    throw new Error("linear: --prompt-file and --description are mutually exclusive");
  }
  if (input.promptFile !== undefined) {
    return readFileSync(input.promptFile, "utf8").trim();
  }
  return input.description?.trim() ?? fallbackTitle;
}

function notesFor(input: CreateTaskInput): string {
  const notes: string[] = [];
  if (input.projects.length > 0) {
    notes.push(`Projects: ${input.projects.join(", ")}`);
  }
  if (input.contexts.length > 0) {
    notes.push(`Contexts: ${input.contexts.join(", ")}`);
  }
  if (input.dependencies.length > 0) {
    notes.push(`Blocked by: ${input.dependencies.join(", ")}`);
  }
  if (input.due !== undefined) {
    notes.push(`Due: ${input.due}`);
  }
  return notes.length === 0 ? "None" : notes.join("\n");
}

async function fetchCreateContext(arguments_: {
  client: LinearClient;
  teamSelector: string;
  agentLabelName: string;
}): Promise<LinearCreateContext> {
  const { client, teamSelector, agentLabelName } = arguments_;
  const response: { data?: unknown } = await client.client.rawRequest(
    `query CreateLinearTaskContext($teamSelector: String!, $teamSelectorId: ID!, $agentLabelName: String!) {
      viewer { id name }
      teams(
        filter: {
          or: [
            { id: { eq: $teamSelectorId } }
            { key: { eqIgnoreCase: $teamSelector } }
          ]
        }
        first: 2
        includeArchived: false
      ) {
        nodes {
          id
          key
          name
          labels(filter: { name: { eq: $agentLabelName } }, first: 2, includeArchived: false) {
            nodes { id name }
          }
          states(first: 50, includeArchived: false) {
            nodes { id name type position }
          }
        }
      }
    }`,
    { teamSelector, teamSelectorId: teamSelector, agentLabelName },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by the GraphQL query above
  return response.data as LinearCreateContext;
}

function requireExactlyOne<T>(items: readonly T[], label: string): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`linear: expected exactly one ${label}, found ${items.length}`);
  }
  return item;
}

function requireTodoState(
  states: readonly LinearWorkflowState[],
  teamKey: string,
): LinearWorkflowState {
  const unstartedStates = states.filter((state) => state.type === "unstarted");
  const todoState =
    findLinearWorkflowStateByName(unstartedStates, TODO_STATE_NAMES) ??
    unstartedStates.toSorted((a, b) => a.position - b.position).at(0);
  if (todoState === undefined) {
    throw new Error(`linear: could not find a Todo workflow state for team ${teamKey}`);
  }
  return todoState;
}

async function createIssue(arguments_: {
  client: LinearClient;
  assigneeId: string;
  description: string;
  dueDate: string | undefined;
  labelId: string;
  priority: number | undefined;
  stateId: string;
  teamId: string;
  title: string;
}): Promise<string> {
  const { client, assigneeId, description, dueDate, labelId, priority, stateId, teamId, title } =
    arguments_;
  const response: { data?: unknown } = await client.client.rawRequest(
    `mutation CreateLinearTask($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier }
      }
    }`,
    {
      input: {
        assigneeId,
        description,
        labelIds: [labelId],
        stateId,
        teamId,
        title,
        ...(dueDate === undefined ? {} : { dueDate }),
        ...(priority === undefined ? {} : { priority }),
      },
    },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by the GraphQL mutation above
  const data = response.data as CreateIssueResponse;
  if (!data.issueCreate.success || data.issueCreate.issue === null) {
    throw new Error("linear: issueCreate did not return a created issue");
  }
  return data.issueCreate.issue.identifier;
}

async function createBlockedByRelation(arguments_: {
  client: LinearClient;
  dependency: string;
  relatedIssueId: string;
  sourceName: string;
}): Promise<void> {
  const { client, dependency, relatedIssueId, sourceName } = arguments_;
  const issueId = normalizeLinearDependencyId(dependency, sourceName);
  const response: { data?: unknown } = await client.client.rawRequest(
    `mutation CreateLinearTaskBlockedBy($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) {
        success
      }
    }`,
    {
      input: {
        issueId,
        relatedIssueId,
        type: "blocks",
      },
    },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by the GraphQL mutation above
  const data = response.data as CreateIssueRelationResponse;
  if (!data.issueRelationCreate.success) {
    throw new Error(`linear: could not create blocked-by relation for ${dependency}`);
  }
}

function normalizeLinearDependencyId(dependency: string, sourceName: string): string {
  const sourcePrefix = `${sourceName}:`;
  if (dependency.toLowerCase().startsWith(sourcePrefix.toLowerCase())) {
    return dependency.slice(sourcePrefix.length);
  }
  if (dependency.includes(":")) {
    throw new Error(
      `linear: dependency "${dependency}" is not a Linear task id for source "${sourceName}"`,
    );
  }
  return dependency;
}
