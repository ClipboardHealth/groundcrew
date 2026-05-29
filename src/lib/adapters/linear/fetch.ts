/**
 * Linear adapter — GraphQL fetch helpers for board/issue data.
 *
 * There is no project / view / status configuration: the only server-side
 * filter is "assigned to the API key's viewer AND carries an `agent-*`
 * label." State classification is driven by Linear's workflow `state.type`
 * (`unstarted` | `started` | `completed` | `canceled` | `duplicate`) —
 * never by status name — so workspaces with renamed columns (Todo -> To Do,
 * Done -> Shipped, etc.) Just Work without per-team config.
 */

import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "../../config.ts";
import { RepositoryResolutionError } from "../../ticketSource.ts";
import { log, styleWarning } from "../../util.ts";
import {
  AGENT_LABEL_PREFIX,
  resolveModelFor,
  resolveRepositoryFor,
  type ModelResolution,
} from "./parsing.ts";

export const ISSUES_PAGE_SIZE = 250;

// `state.type` values surfaced by `fetch()`. `backlog` / `triage` are dropped
// at the GraphQL filter; everything else is post-classified by these names.
const ACTIONABLE_STATE_TYPES = [
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const;

export interface Blocker {
  id: string;
  title: string;
  status: string | undefined;
  /**
   * Linear workflow `state.type` for the blocker (`unstarted` | `started` |
   * `completed` | `canceled` | `duplicate` | `backlog` | `triage`). All
   * canonical classification — todo / in-progress / terminal — keys off this.
   */
  stateType: string | undefined;
}

export interface Issue {
  id: string;
  uuid: string;
  title: string;
  description: string;
  status: string;
  statusId: string;
  /** Linear workflow `state.type` — the source of truth for canonical classification. */
  stateType: string;
  assignee: string;
  updatedAt: string;
  /**
   * `undefined` unless the ticket is in Todo with a parseable `agent-*` label
   * and a known-repo reference in its description — i.e. the dispatcher would
   * actually pick it up. Non-Todo tickets do not resolve repositories because
   * that would invite tick-spam warnings on already-finished work.
   */
  repository: string | undefined;
  /** Parsed from the `agent-*` label when present, including non-Todo tickets for slot logs. */
  model: string | undefined;
  teamId: string;
  blockers: Blocker[];
  hasMoreBlockers: boolean;
  /** Linear `Issue.url` — direct web link to the ticket. */
  url: string;
}

/**
 * `Issue` narrowed to "this ticket is for groundcrew". Consumers operate on
 * the canonical `GroundcrewIssue` from `ticketSource.ts`; this internal
 * variant just shapes the adapter's local Linear type.
 */
export type GroundcrewIssue = Issue & {
  model: string;
  repository: string;
};

/**
 * Linear ticket that was silently dropped from `issues` because it has at
 * least one sub-issue and groundcrew works sub-issues rather than parents.
 */
export interface ParentSkip {
  id: string;
  title: string;
  childCount: number;
}

export interface BoardState {
  timestamp: string;
  issues: Issue[];
  parentSkips: ParentSkip[];
}

export interface BoardSource {
  verify(): Promise<void>;
  fetch(): Promise<BoardState>;
}

interface BoardSourceDeps {
  config: ResolvedConfig;
  client: LinearClient;
}

export function createBoardSource(deps: BoardSourceDeps): BoardSource {
  const { config, client } = deps;
  return {
    async verify() {
      await verifyViewer(client);
    },
    async fetch() {
      return await fetchBoard(client, config);
    },
  };
}

async function verifyViewer(client: LinearClient): Promise<void> {
  const response: { data?: unknown } = await client.client.rawRequest(
    `query VerifyViewer { viewer { id name } }`,
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
  const { viewer } = response.data as {
    viewer: { id: string; name: string } | null;
  };
  if (viewer === null) {
    throw new Error(
      "Linear API did not return a viewer for this API key. Confirm LINEAR_API_KEY is set and points to a personal API key, not a workspace key.",
    );
  }
  log(`Resolved Linear viewer: ${viewer.name}`);
}

export function isIssueInProgress(issue: Pick<Issue, "stateType">): boolean {
  return issue.stateType === "started";
}

export function isIssueTodo(issue: Pick<Issue, "stateType">): boolean {
  return issue.stateType === "unstarted";
}

export function isTerminalStateType(stateType: string | undefined): boolean {
  return stateType === "completed" || stateType === "canceled" || stateType === "duplicate";
}

export function isTerminalStatusForIssue(issue: Pick<Issue, "stateType">): boolean {
  return isTerminalStateType(issue.stateType);
}

/**
 * Terminal check for a blocker. Driven by Linear's workflow `state.type` so
 * renamed status columns ("Shipped" instead of "Done") are still classified
 * correctly. An undefined `stateType` falls through to non-terminal.
 */
export function isTerminalStatusForBlocker(blocker: Blocker): boolean {
  return isTerminalStateType(blocker.stateType);
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  updatedAt: string;
  url: string;
  state?: { id: string; name: string; type: string };
  team?: { id: string; key: string };
  assignee?: { name: string } | null;
  children: { nodes: unknown[] };
  labels: { nodes: { name: string }[] };
  inverseRelations?: {
    nodes: IssueRelationNode[];
    pageInfo: { hasNextPage: boolean };
  };
}

interface IssuesPage {
  nodes: IssueNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string };
}

export interface IssueRelationNode {
  type: string;
  issue?: {
    identifier: string;
    title: string;
    state?: { name: string; type?: string } | null;
  } | null;
}

async function fetchBoard(client: LinearClient, config: ResolvedConfig): Promise<BoardState> {
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  const stateTypes = [...ACTIONABLE_STATE_TYPES];

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on the previous response
    const response: { data?: unknown } = await client.client.rawRequest(
      `query BoardIssues($stateTypes: [String!]!, $agentLabelPrefix: String!, $after: String) {
        issues(
          filter: {
            assignee: { isMe: { eq: true } }
            state: { type: { in: $stateTypes } }
            labels: { some: { name: { startsWith: $agentLabelPrefix } } }
          }
          first: ${ISSUES_PAGE_SIZE}
          after: $after
          includeArchived: false
        ) {
          nodes {
            id
            identifier
            title
            description
            updatedAt
            url
            state { id name type }
            team { id key }
            assignee { name }
            children { nodes { id } }
            labels {
              nodes {
                name
              }
            }
            inverseRelations(first: 50, includeArchived: false) {
              nodes {
                type
                issue {
                  identifier
                  title
                  state { name type }
                }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        stateTypes,
        agentLabelPrefix: AGENT_LABEL_PREFIX,
        after,
      },
    );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
    const { issues: page } = response.data as { issues: IssuesPage };
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) {
      break;
    }
    after = page.pageInfo.endCursor;
  }

  const issues: Issue[] = nodes
    .filter((node) => node.children.nodes.length === 0)
    .map((node) => issueFromNode(node, config));

  const parentSkips: ParentSkip[] = nodes
    .filter((node) => node.children.nodes.length > 0)
    .filter((node) => node.state?.type === "unstarted")
    .map((node) => ({
      id: node.identifier.toLowerCase(),
      title: node.title,
      childCount: node.children.nodes.length,
    }));

  return { timestamp: new Date().toISOString(), issues, parentSkips };
}

export function modelForResolution(
  resolution: Exclude<ModelResolution, { kind: "no-label" }>,
): string {
  if (resolution.kind === "matched") {
    return resolution.model;
  }
  if (resolution.kind === "disabled-fallback") {
    return resolution.fallbackModel;
  }
  return "any";
}

function resolveAgentMetadata(arguments_: {
  ticket: string;
  description: string | undefined;
  modelResolution: ModelResolution;
  config: ResolvedConfig;
  isTodo: boolean;
}): { repository: string | undefined; model: string | undefined } {
  const { ticket, description, modelResolution, config, isTodo } = arguments_;
  let repository: string | undefined;
  let model: string | undefined;
  if (modelResolution.kind === "no-label") {
    return { repository, model };
  }

  model = modelForResolution(modelResolution);
  if (isTodo) {
    const resolution = resolveRepositoryFor({ description, config });
    if (resolution.kind === "ok") {
      ({ repository } = resolution);
    } else {
      model = undefined;
      log(
        styleWarning(
          `WARNING: ${ticket} has an ${AGENT_LABEL_PREFIX}* label but no known repository in its description; skipping dispatch. Add one of workspace.knownRepositories to the description, or remove the ${AGENT_LABEL_PREFIX}* label: ${config.workspace.knownRepositories.join(", ")}`,
        ),
      );
    }
  }
  return { repository, model };
}

function buildLinearIssue(input: {
  identifier: string;
  uuid: string;
  title: string;
  description: string;
  status: string;
  statusId: string;
  stateType: string;
  assigneeName: string | undefined;
  updatedAt: string;
  repository: string | undefined;
  model: string | undefined;
  teamId: string;
  url: string;
  inverseRelations: { nodes: IssueRelationNode[]; pageInfo: { hasNextPage: boolean } } | undefined;
}): Issue {
  return {
    id: input.identifier.toLowerCase(),
    uuid: input.uuid,
    title: input.title,
    description: input.description,
    status: input.status,
    statusId: input.statusId,
    stateType: input.stateType,
    /* v8 ignore next @preserve -- BoardIssues query filters to assignee=isMe so a missing assignee can't occur in practice */
    assignee: input.assigneeName ?? "Unassigned",
    updatedAt: input.updatedAt,
    repository: input.repository,
    model: input.model,
    teamId: input.teamId,
    url: input.url,
    blockers: blockersFromRelations(input.inverseRelations?.nodes ?? []),
    hasMoreBlockers: input.inverseRelations?.pageInfo.hasNextPage ?? false,
  };
}

function issueFromNode(node: IssueNode, config: ResolvedConfig): Issue {
  const modelResolution = resolveModelFor({ labels: node.labels.nodes, config });
  warnIfDisabledFallback(node.identifier, modelResolution, config);
  const { repository, model } = resolveAgentMetadata({
    ticket: node.identifier,
    /* v8 ignore next @preserve -- BoardIssues query selects description; the ?? guard normalises a null vs undefined edge */
    description: node.description ?? undefined,
    modelResolution,
    config,
    isTodo: node.state?.type === "unstarted",
  });
  return buildLinearIssue({
    identifier: node.identifier,
    uuid: node.id,
    title: node.title,
    /* v8 ignore next @preserve -- BoardIssues query always selects description; this `?? ""` is a defensive null vs undefined edge */
    description: node.description ?? "",
    /* v8 ignore next @preserve -- BoardIssues query always returns state */
    status: node.state?.name ?? "Unknown",
    /* v8 ignore next @preserve -- BoardIssues query always returns state */
    statusId: node.state?.id ?? "",
    /* v8 ignore next @preserve -- BoardIssues query always returns state */
    stateType: node.state?.type ?? "",
    assigneeName: node.assignee?.name,
    updatedAt: node.updatedAt,
    repository,
    model,
    teamId: node.team?.id ?? "",
    url: node.url,
    inverseRelations: node.inverseRelations,
  });
}

interface ResolvedIssue {
  uuid: string;
  title: string;
  description: string;
  repository: string;
  model: string;
  teamId: string;
  stateType: string;
  status: string;
  statusId: string;
  url: string;
}

const ISSUE_LABEL_PAGE_SIZE = 50;
const ISSUE_RELATION_PAGE_SIZE = 50;

export interface RawLinearIssue {
  uuid: string;
  title: string;
  description: string;
  teamId: string;
  labels: { name: string }[];
  /** Linear workflow state name, e.g. "Todo", "In Review". May be "" if state was null. */
  stateName: string;
  stateType: string;
  stateId: string;
  blockers: Blocker[];
  hasMoreBlockers: boolean;
  /**
   * `true` when the ticket has at least one sub-issue (child). Parent
   * tickets are filtered out by `fetchBoard` and never dispatched —
   * doctor reads this to surface that decision instead of falsely
   * reporting "would dispatch."
   */
  hasChildren: boolean;
  /** Linear `Issue.url` — direct web link to the ticket. */
  url: string;
}

export async function fetchBlockersForTicket(arguments_: {
  client: LinearClient;
  ticket: string;
  uuid: string;
}): Promise<readonly Blocker[]> {
  const { client, uuid } = arguments_;
  const relations: IssueRelationNode[] = [];
  let after: string | null = null;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on the previous response
    const response: { data?: unknown } = await client.client.rawRequest(
      `query IssueBlockers($id: String!, $after: String) {
        issue(id: $id) {
          inverseRelations(first: ${ISSUE_RELATION_PAGE_SIZE}, after: $after, includeArchived: false) {
            nodes {
              type
              issue {
                identifier
                title
                state { name type }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: uuid, after },
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
    const { issue } = response.data as {
      issue: {
        inverseRelations: {
          nodes: IssueRelationNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      } | null;
    };
    if (issue === null) {
      return [];
    }

    relations.push(...issue.inverseRelations.nodes);
    if (!issue.inverseRelations.pageInfo.hasNextPage) {
      break;
    }
    after = issue.inverseRelations.pageInfo.endCursor;
  }

  return blockersFromRelations(relations);
}

export async function fetchRawLinearIssue(arguments_: {
  client: LinearClient;
  ticket: string;
}): Promise<RawLinearIssue> {
  const { client, ticket } = arguments_;
  const response: { data?: unknown } = await client.client.rawRequest(
    `query ResolveIssue($id: String!) {
      issue(id: $id) {
        id
        title
        description
        url
        team { id }
        state { id name type }
        children { nodes { id } }
        labels(first: ${ISSUE_LABEL_PAGE_SIZE}) {
          nodes { name }
        }
        inverseRelations(first: 50, includeArchived: false) {
          nodes {
            type
            issue {
              identifier
              title
              state { name type }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }`,
    { id: ticket.toUpperCase() },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
  const { issue } = response.data as {
    issue: {
      id: string;
      title: string;
      description?: string | null;
      url: string;
      team?: { id: string } | null;
      state?: { id: string; name: string; type: string } | null;
      children?: { nodes: { id: string }[] } | null;
      labels: { nodes: { name: string }[] };
      inverseRelations?: {
        nodes: IssueRelationNode[];
        pageInfo: { hasNextPage: boolean };
      };
    } | null;
  };
  if (issue === null) {
    throw new Error(`Ticket ${ticket.toUpperCase()} not found in Linear`);
  }
  return {
    uuid: issue.id,
    title: issue.title,
    description: issue.description ?? "",
    /* v8 ignore next @preserve -- ResolveIssue query selects team.id; null only if Linear genuinely returns a teamless ticket */
    teamId: issue.team?.id ?? "",
    labels: issue.labels.nodes,
    /* v8 ignore next @preserve -- ResolveIssue query selects state; null only if Linear genuinely returns a stateless ticket */
    stateName: issue.state?.name ?? "",
    /* v8 ignore next @preserve -- ResolveIssue query selects state; null only if Linear genuinely returns a stateless ticket */
    stateType: issue.state?.type ?? "",
    /* v8 ignore next @preserve -- ResolveIssue query selects state; null only if Linear genuinely returns a stateless ticket */
    stateId: issue.state?.id ?? "",
    blockers: blockersFromRelations(issue.inverseRelations?.nodes ?? []),
    hasMoreBlockers: issue.inverseRelations?.pageInfo.hasNextPage ?? false,
    hasChildren: (issue.children?.nodes.length ?? 0) > 0,
    url: issue.url,
  };
}

interface InProgressIssuesPage {
  nodes: {
    id: string;
    state?: { type: string } | null;
  }[];
  pageInfo: { hasNextPage: boolean; endCursor: string };
}

export async function fetchInProgressIssueCount(arguments_: {
  client: LinearClient;
}): Promise<number> {
  const { client } = arguments_;
  let after: string | null = null;
  let count = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on the previous response
    const response: { data?: unknown } = await client.client.rawRequest(
      `query InProgressIssues($agentLabelPrefix: String!, $after: String) {
        issues(
          filter: {
            assignee: { isMe: { eq: true } }
            state: { type: { eq: "started" } }
            labels: { some: { name: { startsWith: $agentLabelPrefix } } }
          }
          first: ${ISSUES_PAGE_SIZE}
          after: $after
          includeArchived: false
        ) {
          nodes {
            id
            state { type }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        agentLabelPrefix: AGENT_LABEL_PREFIX,
        after,
      },
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
    const { issues: page } = response.data as { issues: InProgressIssuesPage };
    for (const node of page.nodes) {
      /* v8 ignore else @preserve -- InProgressIssues query filters server-side to state.type=started; the else branch is unreachable in production */
      if (node.state?.type === "started") {
        count += 1;
      }
    }
    if (!page.pageInfo.hasNextPage) {
      return count;
    }
    after = page.pageInfo.endCursor;
  }
}

export async function fetchResolvedIssue(arguments_: {
  client: LinearClient;
  config: ResolvedConfig;
  ticket: string;
}): Promise<ResolvedIssue> {
  const { client, config, ticket } = arguments_;
  const upper = ticket.toUpperCase();
  const raw = await fetchRawLinearIssue({ client, ticket });
  const repositoryResolution = resolveRepositoryFor({
    description: raw.description,
    config,
  });
  if (repositoryResolution.kind === "missing") {
    throw new RepositoryResolutionError({
      ticket: upper,
      repositories: config.workspace.knownRepositories,
    });
  }
  const modelResolution = resolveModelFor({ labels: raw.labels, config });
  warnIfDisabledFallback(ticket, modelResolution, config);
  let model = config.models.default;
  if (modelResolution.kind === "matched") {
    ({ model } = modelResolution);
  } else if (modelResolution.kind === "disabled-fallback") {
    model = modelResolution.fallbackModel;
  }
  return {
    uuid: raw.uuid,
    title: raw.title,
    description: raw.description,
    repository: repositoryResolution.repository,
    model,
    teamId: raw.teamId,
    stateType: raw.stateType,
    status: raw.stateName,
    statusId: raw.stateId,
    url: raw.url,
  };
}

export function warnIfDisabledFallback(
  ticket: string,
  modelResolution: ModelResolution,
  config: ResolvedConfig,
): void {
  if (modelResolution.kind !== "disabled-fallback") {
    return;
  }
  log(
    `${ticket.toLowerCase()}: agent-${modelResolution.requestedModel} label refers to a disabled model; falling back to models.default (${config.models.default})`,
  );
}

export function blockersFromRelations(relations: IssueRelationNode[]): Blocker[] {
  return relations
    .filter((relation) => relation.type === "blocks")
    .map((relation) => ({
      id: relation.issue?.identifier?.toLowerCase() ?? "unknown",
      title: relation.issue?.title ?? "",
      status: relation.issue?.state?.name,
      stateType: relation.issue?.state?.type,
    }));
}
