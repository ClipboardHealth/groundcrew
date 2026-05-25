/**
 * Linear adapter — turns the project's GraphQL state into a `BoardState`
 * snapshot. Owns the GraphQL queries and shape parsing so callers consume a
 * typed `BoardState` instead of raw nodes.
 */

import type { LinearClient } from "@linear/sdk";

import {
  AGENT_ANY_MODEL,
  findProjectBySlugId,
  isShippedDefaultDisabled,
  type ResolvedConfig,
  type ResolvedProjectConfig,
  unionTerminalStatuses,
} from "./config.ts";
import { RepositoryResolutionError } from "./ticketSource.ts";
import { log } from "./util.ts";

export const AGENT_LABEL_PREFIX = "agent-";
export const ISSUES_PAGE_SIZE = 250;

export interface Blocker {
  id: string;
  title: string;
  status: string | undefined;
  /**
   * SlugId of the project the blocker lives in. `undefined` when Linear
   * returned no project for the blocker (rare — issues can technically
   * exist without a project). Drives `isTerminalStatusForBlocker`'s
   * pick between the blocker's own project terminals and the global
   * union fallback.
   */
  projectSlugId: string | undefined;
}

export interface Issue {
  id: string;
  uuid: string;
  title: string;
  status: string;
  statusId: string;
  assignee: string;
  updatedAt: string;
  /**
   * `undefined` unless the ticket is in Todo with a parseable `agent-*` label
   * and a known-repo reference in its description — i.e. the dispatcher would
   * actually pick it up. Resolving on non-Todo statuses would just invite
   * tick-spam warnings on already-finished work.
   */
  repository: string | undefined;
  /** `undefined` whenever `repository` is — the two are populated together. */
  model: string | undefined;
  teamId: string;
  /** SlugId of the Linear project the issue belongs to — always one of `linear.projects[*].slugId`. */
  projectSlugId: string;
  blockers: Blocker[];
  hasMoreBlockers: boolean;
}

/**
 * `Issue` narrowed to "this ticket is for groundcrew" — produced by filtering
 * through `isGroundcrewIssue`. Use this type wherever downstream code reads
 * `model`/`repository` and the issue has already been through that filter.
 */
export type GroundcrewIssue = Issue & {
  model: string;
  repository: string;
};

export function isGroundcrewIssue(issue: Issue): issue is GroundcrewIssue {
  return issue.model !== undefined && issue.repository !== undefined;
}

/**
 * Linear ticket that was silently dropped from `issues` because it has at
 * least one sub-issue and groundcrew works sub-issues rather than parents.
 * The dispatcher logs each one per tick so operators see WHY a Todo ticket
 * isn't being picked up instead of just "No Todo tickets to pick up." Only
 * Todo+agent-labelled parents qualify — non-actionable parents (e.g. Done
 * epics) would be noise.
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

// Canonical RepositoryResolutionError lives in ./ticketSource.ts (imported at
// the top of this file). Re-exported here so existing consumers of
// boardSource.ts keep compiling until a follow-up PR completes the consumer
// refactor and deletes this file.
export { RepositoryResolutionError };

export class UnknownProjectError extends Error {
  public readonly ticket: string;
  public readonly projectSlugId: string | undefined;
  public readonly configuredSlugIds: readonly string[];

  public constructor(arguments_: {
    ticket: string;
    projectSlugId: string | undefined;
    configuredSlugIds: readonly string[];
  }) {
    const { ticket, projectSlugId, configuredSlugIds } = arguments_;
    const ticketProjectClause =
      projectSlugId === undefined
        ? "has no associated Linear project"
        : `belongs to Linear project slugId "${projectSlugId}"`;
    super(
      `Ticket ${ticket} ${ticketProjectClause}, which is not in linear.projects (configured: ${configuredSlugIds.join(", ")}). Add the project to your crew config or pick a ticket from a configured project.`,
    );
    this.name = "UnknownProjectError";
    this.ticket = ticket;
    this.projectSlugId = projectSlugId;
    this.configuredSlugIds = configuredSlugIds;
  }
}

export interface BoardSource {
  /**
   * Look up the configured projects and warn loudly on any that aren't
   * there. Throws only when zero projects resolve, so a typo in one of
   * several entries doesn't abort the watch loop. Run once at startup
   * so misconfigurations surface before the first tick.
   */
  verify(): Promise<void>;
  /** Fetch the current board snapshot. Paginates internally. */
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
      await verifyProjects(client, config);
    },
    async fetch() {
      return await fetchBoard(client, config);
    },
  };
}

export function projectFor(issue: Issue, config: ResolvedConfig): ResolvedProjectConfig {
  const resolved = findProjectBySlugId(config, issue.projectSlugId);
  /* v8 ignore next 5 @preserve -- fetchBoard's slugId filter and issueStatusBelongsToOwnProject keep production issues from reaching here with an unknown slugId */
  if (resolved === undefined) {
    throw new Error(
      `Issue ${issue.id} carries projectSlugId "${issue.projectSlugId}" which is not in linear.projects`,
    );
  }
  return resolved;
}

export function isTerminalStatusForIssue(issue: Issue, config: ResolvedConfig): boolean {
  return projectFor(issue, config).statuses.terminal.includes(issue.status);
}

/**
 * Terminal check for a blocker. When the blocker lives in a configured
 * project, we use that project's terminal list directly. Otherwise we
 * fall back to the union of terminals across all configured projects —
 * matches today's single-project "is this name in our terminal list?"
 * behavior so off-config blockers don't regress.
 */
export function isTerminalStatusForBlocker(blocker: Blocker, config: ResolvedConfig): boolean {
  if (blocker.status === undefined) {
    return false;
  }
  if (blocker.projectSlugId !== undefined) {
    const project = findProjectBySlugId(config, blocker.projectSlugId);
    if (project !== undefined) {
      return project.statuses.terminal.includes(blocker.status);
    }
  }
  return unionTerminalStatuses(config).has(blocker.status);
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  updatedAt: string;
  state?: { id: string; name: string };
  team?: { id: string; key: string };
  assignee?: { name: string } | null;
  project?: { slugId: string } | null;
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
    state?: { name: string } | null;
    project?: { slugId: string } | null;
  } | null;
}

async function verifyProjects(client: LinearClient, config: ResolvedConfig): Promise<void> {
  const slugIds = config.linear.projects.map((project) => project.slugId);
  const response: { data?: unknown } = await client.client.rawRequest(
    `query VerifyProjects($slugIds: [String!]!) {
      projects(filter: { slugId: { in: $slugIds } }, first: ${slugIds.length}) {
        nodes { id name slugId }
      }
    }`,
    { slugIds },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
  const { projects } = response.data as {
    projects: { nodes: { id: string; name: string; slugId: string }[] };
  };
  const resolved = new Map(
    projects.nodes.map((project) => [project.slugId.toLowerCase(), project]),
  );
  for (const project of config.linear.projects) {
    const found = resolved.get(project.slugId);
    if (found === undefined) {
      log(
        `WARNING: no Linear project found with slugId "${project.slugId}" (linear.projects entry "${project.projectSlug}"). Check for typos, archived projects, or missing API-key access. Continuing without this project.`,
      );
      continue;
    }
    log(`Resolved Linear project: ${found.name} (slugId ${found.slugId})`);
  }
  if (resolved.size === 0) {
    throw new Error(
      `No Linear projects resolved from linear.projects (${config.linear.projects.map((project) => `"${project.projectSlug}"`).join(", ")}). Confirm slugs match the trailing segment of each project's URL and that your Linear API key can access this workspace.`,
    );
  }
}

async function fetchBoard(client: LinearClient, config: ResolvedConfig): Promise<BoardState> {
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  // Two server-side filters narrow the response to tickets the orchestrator
  // can actually act on:
  //   1. State: union of every configured project's
  //      {todo, inProgress, done, terminal} state names. Backlog, Triage,
  //      and custom columns are dropped server-side. Each issue is
  //      post-filtered against ITS OWN project's statuses below so a
  //      state name from project A doesn't leak into project B.
  //   2. Labels: at least one `agent-*` label — i.e. someone opted the ticket
  //      in to groundcrew. Without this, every human-owned ticket on a shared
  //      project would round-trip back just to be filtered out client-side.
  // The client-side `isGroundcrewIssue` guard in dispatcher.ts is now
  // belt-and-suspenders against query drift, not the load-bearing filter.
  const slugIds = config.linear.projects.map((project) => project.slugId);
  const stateNames = [
    ...new Set(
      config.linear.projects.flatMap((project) => [
        project.statuses.todo,
        project.statuses.inProgress,
        project.statuses.done,
        ...project.statuses.terminal,
      ]),
    ),
  ];

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on the previous response
    const response: { data?: unknown } = await client.client.rawRequest(
      `query BoardIssues($slugIds: [String!]!, $stateNames: [String!]!, $agentLabelPrefix: String!, $after: String) {
        issues(
          filter: {
            project: { slugId: { in: $slugIds } }
            state: { name: { in: $stateNames } }
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
            state { id name }
            team { id key }
            assignee { name }
            project { slugId }
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
                  state { name }
                  project { slugId }
                }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        slugIds,
        stateNames,
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

  // Only parse `repository` for tickets that opted in via an `agent-*` label.
  // Unlabeled tickets are not groundcrew's concern even when they share a
  // configured state name with one that is.
  const issues: Issue[] = nodes
    .filter((node) => node.children.nodes.length === 0)
    .filter((node) => issueStatusBelongsToOwnProject(node, config))
    .map((node) => issueFromNode(node, config));

  const parentSkips: ParentSkip[] = nodes
    .filter((node) => node.children.nodes.length > 0)
    .filter((node) => isTodoStatusForOwnProject(node, config))
    .map((node) => ({
      id: node.identifier.toLowerCase(),
      title: node.title,
      childCount: node.children.nodes.length,
    }));

  return { timestamp: new Date().toISOString(), issues, parentSkips };
}

/**
 * Checks whether the node sits in Todo under its own project's configured
 * status names. Used to narrow parent skips (Done / In Progress parents
 * aren't surprising drops, so we don't log them) and to gate the repository
 * parse on the only status the dispatcher acts on — In Progress / Done
 * tickets never read `Issue.repository` so parsing it for them just creates
 * tick-spamming warnings when an operator already-finished ticket can't be
 * re-parsed.
 */
function isTodoStatusForOwnProject(node: IssueNode, config: ResolvedConfig): boolean {
  const slugId = node.project?.slugId?.toLowerCase();
  /* v8 ignore next 3 @preserve -- GraphQL slugId filter scopes results to configured projects */
  if (slugId === undefined) {
    return false;
  }
  const project = findProjectBySlugId(config, slugId);
  /* v8 ignore next 3 @preserve -- GraphQL slugId filter scopes results to configured projects */
  if (project === undefined) {
    return false;
  }
  return node.state?.name === project.statuses.todo;
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
  return AGENT_ANY_MODEL;
}

/**
 * Build a canonical `Issue` from a Linear GraphQL node. Used by both
 * project-mode (`issueFromNode`) and view-mode (`issueFromViewNode`)
 * fetch paths so the shared return shape lives in one place.
 */
/**
 * Resolve `{ repository, model }` for a Todo (or unstarted) Linear ticket
 * that carries an `agent-*` label. Both project mode and view mode use
 * this — only the `isTodo` predicate differs (project: own-project status
 * match, view: state.type === "unstarted").
 */
export function resolveTodoAgentMetadata(arguments_: {
  ticket: string;
  description: string | undefined;
  modelResolution: ModelResolution;
  config: ResolvedConfig;
  isTodo: boolean;
}): { repository: string | undefined; model: string | undefined } {
  const { ticket, description, modelResolution, config, isTodo } = arguments_;
  let repository: string | undefined;
  let model: string | undefined;
  if (modelResolution.kind !== "no-label" && isTodo) {
    const resolution = resolveRepositoryFor({ description, config, ticket });
    if (resolution.kind === "ok") {
      ({ repository } = resolution);
      model = modelForResolution(modelResolution);
    } else {
      log(
        `WARNING: ${ticket} has an ${AGENT_LABEL_PREFIX}* label but no known repository in its description; skipping dispatch. Add one of workspace.knownRepositories to the description, or remove the ${AGENT_LABEL_PREFIX}* label: ${config.workspace.knownRepositories.join(", ")}`,
      );
    }
  }
  return { repository, model };
}

export function buildLinearIssue(input: {
  identifier: string;
  uuid: string;
  title: string;
  status: string;
  statusId: string;
  assigneeName: string | undefined;
  updatedAt: string;
  repository: string | undefined;
  model: string | undefined;
  teamId: string;
  projectSlugId: string;
  inverseRelations: { nodes: IssueRelationNode[]; pageInfo: { hasNextPage: boolean } } | undefined;
}): Issue {
  return {
    id: input.identifier.toLowerCase(),
    uuid: input.uuid,
    title: input.title,
    status: input.status,
    statusId: input.statusId,
    assignee: input.assigneeName ?? "Unassigned",
    updatedAt: input.updatedAt,
    repository: input.repository,
    model: input.model,
    teamId: input.teamId,
    projectSlugId: input.projectSlugId,
    blockers: blockersFromRelations(input.inverseRelations?.nodes ?? []),
    hasMoreBlockers: input.inverseRelations?.pageInfo.hasNextPage ?? false,
  };
}

function issueFromNode(node: IssueNode, config: ResolvedConfig): Issue {
  const modelResolution = resolveModelFor({ labels: node.labels.nodes, config });
  warnIfDisabledFallback(node.identifier, modelResolution, config);
  // Only the dispatcher reads `Issue.repository` / `Issue.model`, and only on
  // tickets in the Todo column it's about to pick up. Resolving them for In
  // Progress (already running) or Done (cleaner only needs the id) would just
  // invite tick-spam warnings on already-finished tickets — e.g. when a
  // description was edited or knownRepositories changed after dispatch. A
  // ticket sitting in Todo with no parseable repo is still the operator's
  // bug, so surface it loudly there and treat it as not-eligible so the rest
  // of the board still ticks instead of the whole watch loop crashing on
  // one bad ticket.
  const { repository, model } = resolveTodoAgentMetadata({
    ticket: node.identifier,
    description: node.description ?? undefined,
    modelResolution,
    config,
    isTodo: isTodoStatusForOwnProject(node, config),
  });
  // `issueStatusBelongsToOwnProject` drops nodes whose `state` or `project`
  // is missing, so by the time we land here both are defined. The nullish
  // coalescing on those fields is belt-and-suspenders for type narrowing.
  return buildLinearIssue({
    identifier: node.identifier,
    uuid: node.id,
    title: node.title,
    /* v8 ignore next @preserve -- post-filter guarantees `state` is defined */
    status: node.state?.name ?? "Unknown",
    /* v8 ignore next @preserve -- post-filter guarantees `state` is defined */
    statusId: node.state?.id ?? "",
    assigneeName: node.assignee?.name,
    updatedAt: node.updatedAt,
    repository,
    model,
    teamId: node.team?.id ?? "",
    /* v8 ignore next @preserve -- post-filter guarantees `project` is defined */
    projectSlugId: node.project?.slugId?.toLowerCase() ?? "",
    inverseRelations: node.inverseRelations,
  });
}

/**
 * Drops issues whose status name isn't recognized by their own project's
 * configured statuses. The union `stateNames` filter sent to Linear can
 * pull in an issue from project A whose status name appears in project
 * B's status list but not A's; this guard removes that cross-project
 * leakage so each issue is judged only against its own project's rules.
 */
function issueStatusBelongsToOwnProject(node: IssueNode, config: ResolvedConfig): boolean {
  const slugId = node.project?.slugId?.toLowerCase();
  if (slugId === undefined) {
    return false;
  }
  const project = findProjectBySlugId(config, slugId);
  if (project === undefined) {
    return false;
  }
  const status = node.state?.name;
  /* v8 ignore next 3 @preserve -- GraphQL state filter only returns issues whose state name is in the configured union; an undefined status implies a degenerate Linear response */
  if (status === undefined) {
    return false;
  }
  return projectStateNames(project).has(status);
}

function projectStateNames(project: ResolvedProjectConfig): ReadonlySet<string> {
  return new Set<string>([
    project.statuses.todo,
    project.statuses.inProgress,
    project.statuses.done,
    ...project.statuses.terminal,
  ]);
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

// Sort by descending length so longer names match first — `api-admin`
// must beat `api` when both are configured. `\b` treats `-` as a word
// boundary, so without this ordering `api` would win on `api-admin`.
function buildRepositoryRegex(config: ResolvedConfig): RegExp {
  const candidates = config.workspace.knownRepositories.flatMap((repo) => {
    const slashIndex = repo.indexOf("/");
    return slashIndex === -1 ? [repo] : [repo, repo.slice(slashIndex + 1)];
  });
  const alternation = candidates
    .toSorted((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  return new RegExp(String.raw`\b(${alternation})\b`);
}

interface ResolvedIssue {
  uuid: string;
  title: string;
  description: string;
  repository: string;
  model: string;
  teamId: string;
  projectSlugId: string;
}

const ISSUE_LABEL_PAGE_SIZE = 50;
const ISSUE_RELATION_PAGE_SIZE = 50;

export interface RawLinearIssue {
  uuid: string;
  title: string;
  description: string;
  teamId: string;
  projectSlugId: string | undefined;
  labels: { name: string }[];
  /** Linear workflow state name, e.g. "Todo", "In Review". May be "" if state was null. */
  stateName: string;
  /**
   * Linear workflow state type, e.g. "unstarted", "started", "completed", "canceled".
   * "" when state was null. Optional in the type to keep project-mode test fixtures
   * terse — only view-mode probes consult it.
   */
  stateType?: string;
  blockers: Blocker[];
  hasMoreBlockers: boolean;
  /**
   * `true` when the ticket has at least one sub-issue (child). Parent
   * tickets are filtered out by `fetchBoard` and never dispatched —
   * doctor reads this to surface that decision instead of falsely
   * reporting "would dispatch."
   */
  hasChildren: boolean;
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
                state { name }
                project { slugId }
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
        team { id }
        project { slugId }
        state { name type }
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
              state { name }
              project { slugId }
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
      team?: { id: string } | null;
      project?: { slugId: string } | null;
      state?: { name: string; type: string } | null;
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
    teamId: issue.team?.id ?? "",
    projectSlugId: issue.project?.slugId?.toLowerCase(),
    labels: issue.labels.nodes,
    stateName: issue.state?.name ?? "",
    stateType: issue.state?.type ?? "",
    blockers: blockersFromRelations(issue.inverseRelations?.nodes ?? []),
    hasMoreBlockers: issue.inverseRelations?.pageInfo.hasNextPage ?? false,
    hasChildren: (issue.children?.nodes.length ?? 0) > 0,
  };
}

interface InProgressIssuesPage {
  nodes: {
    id: string;
    project?: { slugId: string } | null;
    state?: { name: string } | null;
  }[];
  pageInfo: { hasNextPage: boolean; endCursor: string };
}

export async function fetchInProgressIssueCount(arguments_: {
  client: LinearClient;
  config: ResolvedConfig;
}): Promise<number> {
  const { client, config } = arguments_;
  const slugIds = config.linear.projects.map((project) => project.slugId);
  // The union state filter is permissive: it can pull in an issue whose state
  // name happens to match a different project's `inProgress`. Post-filter
  // against each issue's OWN project to count only true in-progress tickets.
  const stateNames = [
    ...new Set(config.linear.projects.map((project) => project.statuses.inProgress)),
  ];
  let after: string | null = null;
  let count = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on the previous response
    const response: { data?: unknown } = await client.client.rawRequest(
      `query InProgressIssues($slugIds: [String!]!, $stateNames: [String!]!, $agentLabelPrefix: String!, $after: String) {
        issues(
          filter: {
            project: { slugId: { in: $slugIds } }
            state: { name: { in: $stateNames } }
            labels: { some: { name: { startsWith: $agentLabelPrefix } } }
          }
          first: ${ISSUES_PAGE_SIZE}
          after: $after
          includeArchived: false
        ) {
          nodes {
            id
            project { slugId }
            state { name }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        slugIds,
        stateNames,
        agentLabelPrefix: AGENT_LABEL_PREFIX,
        after,
      },
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
    const { issues: page } = response.data as { issues: InProgressIssuesPage };
    for (const node of page.nodes) {
      const slugId = node.project?.slugId?.toLowerCase();
      /* v8 ignore next 3 @preserve -- GraphQL slugId filter scopes results to configured projects */
      if (slugId === undefined) {
        continue;
      }
      const project = findProjectBySlugId(config, slugId);
      /* v8 ignore next 3 @preserve -- GraphQL slugId filter scopes results to configured projects */
      if (project === undefined) {
        continue;
      }
      if (node.state?.name === project.statuses.inProgress) {
        count += 1;
      }
    }
    if (!page.pageInfo.hasNextPage) {
      return count;
    }
    after = page.pageInfo.endCursor;
  }
}

export type RepositoryResolution = { kind: "ok"; repository: string } | { kind: "missing" };

export function resolveRepositoryFor(arguments_: {
  description: string | undefined;
  config: ResolvedConfig;
  ticket: string;
}): RepositoryResolution {
  const { description, config } = arguments_;
  if (description === undefined || description.length === 0) {
    return { kind: "missing" };
  }
  const match = buildRepositoryRegex(config).exec(description)?.[1];
  if (match === undefined) {
    return { kind: "missing" };
  }
  // `buildRepositoryRegex` matches both the full `owner/repo` entry and its bare
  // suffix, so the captured value can be either form. Downstream code composes
  // the resolved value with `workspace.projectDir` and needs the exact
  // `knownRepositories` entry, so resolve back to that form here.
  const candidates = config.workspace.knownRepositories.filter(
    (entry) => entry === match || entry.endsWith(`/${match}`),
  );
  if (candidates.length !== 1) {
    return { kind: "missing" };
  }
  const [canonical] = candidates;
  /* v8 ignore next 3 @preserve -- candidates.length === 1 guarantees [0] is defined */
  if (canonical === undefined) {
    return { kind: "missing" };
  }
  return { kind: "ok", repository: canonical };
}

export type ModelResolution =
  | { kind: "matched"; model: string }
  | { kind: "no-label" }
  | { kind: "agent-any" }
  | { kind: "disabled-fallback"; requestedModel: string; fallbackModel: string };

export function resolveModelFor(arguments_: {
  labels: { name: string }[];
  config: ResolvedConfig;
}): ModelResolution {
  const { labels, config } = arguments_;
  const parsed = parseAgentLabels(labels, config);
  if (parsed === undefined) {
    return { kind: "no-label" };
  }
  if (parsed.model === AGENT_ANY_MODEL) {
    return { kind: "agent-any" };
  }
  if (parsed.disabledFallback !== undefined) {
    return {
      kind: "disabled-fallback",
      requestedModel: parsed.disabledFallback,
      fallbackModel: parsed.model,
    };
  }
  return { kind: "matched", model: parsed.model };
}

/**
 * `agent-any` collapses to `models.default` here — manual setup doesn't run
 * the usage-gated `any` resolver, so the caller gets a concrete model name
 * instead of a sentinel that downstream code can't interpret. Throws
 * `UnknownProjectError` when the ticket lives in a Linear project that
 * isn't listed in `linear.projects`, so callers can surface the misconfiguration
 * instead of silently using the wrong status names.
 */
export interface ResolvedAgentMetadata {
  uuid: string;
  title: string;
  description: string;
  repository: string;
  model: string;
  teamId: string;
  projectSlugId: string | undefined;
  labels: { name: string }[];
  stateName: string;
}

/**
 * Run the shared "resolve repository + model from a Linear ticket" flow
 * used by both project mode (`fetchResolvedIssue`) and view mode
 * (`resolveOneByIdentifier`). Throws `RepositoryResolutionError` when no
 * knownRepositories match the description. Project-specific checks (e.g.
 * `UnknownProjectError`) live in their respective callers.
 */
export async function resolveAgentMetadata(arguments_: {
  client: LinearClient;
  config: ResolvedConfig;
  ticket: string;
}): Promise<ResolvedAgentMetadata> {
  const { client, config, ticket } = arguments_;
  const upper = ticket.toUpperCase();
  const raw = await fetchRawLinearIssue({ client, ticket });
  const repositoryResolution = resolveRepositoryFor({
    description: raw.description,
    config,
    ticket: upper,
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
    projectSlugId: raw.projectSlugId,
    labels: raw.labels,
    stateName: raw.stateName,
  };
}

export async function fetchResolvedIssue(arguments_: {
  client: LinearClient;
  config: ResolvedConfig;
  ticket: string;
}): Promise<ResolvedIssue> {
  const { config, ticket } = arguments_;
  const upper = ticket.toUpperCase();
  const resolved = await resolveAgentMetadata(arguments_);
  const project =
    resolved.projectSlugId === undefined
      ? undefined
      : findProjectBySlugId(config, resolved.projectSlugId);
  if (project === undefined) {
    throw new UnknownProjectError({
      ticket: upper,
      projectSlugId: resolved.projectSlugId,
      configuredSlugIds: config.linear.projects.map((entry) => entry.slugId),
    });
  }
  return {
    uuid: resolved.uuid,
    title: resolved.title,
    description: resolved.description,
    repository: resolved.repository,
    model: resolved.model,
    teamId: resolved.teamId,
    projectSlugId: project.slugId,
  };
}

/**
 * Returns the resolved agent metadata for a ticket, or `undefined` when the
 * ticket has no `agent-*` label — those tickets are not groundcrew's concern
 * and downstream code skips them. An explicit `agent-<unknown>` label still
 * falls back to `models.default` because the user opted in by labeling.
 *
 * `disabledFallback` is set when the label matched a shipped default the user
 * explicitly disabled (e.g. `agent-codex` against `codex: { disabled: true }`).
 * Callers warn on this so the user can spot the config/labeling mismatch; we
 * still fall back rather than skip because skipping would block the ticket
 * indefinitely. Unknown labels stay silent — those are likelier to be typos.
 */
interface ParsedAgentLabels {
  model: string;
  disabledFallback?: string;
}

function parseAgentLabels(
  labels: { name: string }[],
  config: ResolvedConfig,
): ParsedAgentLabels | undefined {
  const agentLabels = labels.filter((label) => label.name.startsWith(AGENT_LABEL_PREFIX));
  if (agentLabels.length === 0) {
    return undefined;
  }
  let disabledFallback: string | undefined;
  for (const label of agentLabels) {
    const name = label.name.slice(AGENT_LABEL_PREFIX.length);
    if (name === AGENT_ANY_MODEL) {
      return { model: AGENT_ANY_MODEL };
    }
    // Own-property check, not `in`: a label like `agent-toString` or
    // `agent-__proto__` would otherwise resolve through the prototype chain
    // instead of falling back to `models.default`.
    if (Object.hasOwn(config.models.definitions, name)) {
      return { model: name };
    }
    if (disabledFallback === undefined && isShippedDefaultDisabled(config, name)) {
      disabledFallback = name;
    }
  }
  const fallback: ParsedAgentLabels = { model: config.models.default };
  if (disabledFallback !== undefined) {
    fallback.disabledFallback = disabledFallback;
  }
  return fallback;
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
      projectSlugId: relation.issue?.project?.slugId?.toLowerCase(),
    }));
}
