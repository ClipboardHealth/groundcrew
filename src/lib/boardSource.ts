/**
 * Linear adapter — turns the viewer's GraphQL state into a `BoardState`
 * snapshot. Owns the GraphQL queries and shape parsing so callers consume a
 * typed `BoardState` instead of raw nodes.
 *
 * There is no project / view / status configuration: the only filter is
 * "assigned to the API key's viewer AND carries an `agent-*` label."
 * State classification is driven by Linear's workflow `state.type`
 * (`unstarted` | `started` | `completed` | `canceled` | `duplicate`) —
 * never by status name — so workspaces with renamed columns (Todo → To Do,
 * Done → Shipped, etc.) Just Work.
 */

import type { LinearClient } from "@linear/sdk";

import { AGENT_ANY_MODEL, isShippedDefaultDisabled, type ResolvedConfig } from "./config.ts";
import { RepositoryResolutionError } from "./ticketSource.ts";
import { log } from "./util.ts";

export const AGENT_LABEL_PREFIX = "agent-";
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
  status: string;
  statusId: string;
  /** Linear workflow `state.type` — the source of truth for canonical classification. */
  stateType: string;
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

export interface BoardSource {
  /**
   * Verify the Linear API key resolves to a viewer. Run once at startup so
   * misconfiguration surfaces before the first tick.
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
      await verifyViewer(client);
    },
    async fetch() {
      return await fetchBoard(client, config);
    },
  };
}

async function verifyViewer(client: LinearClient): Promise<void> {
  const response: { data?: unknown } = await client.client.rawRequest(
    `query VerifyViewer { viewer { id name email } }`,
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
  const { viewer } = response.data as {
    viewer: { id: string; name: string; email: string } | null;
  };
  if (viewer === null) {
    throw new Error(
      "Linear API did not return a viewer for this API key. Confirm LINEAR_API_KEY is set and points to a personal API key, not a workspace key.",
    );
  }
  log(`Resolved Linear viewer: ${viewer.name} (${viewer.email})`);
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
  // Three server-side filters narrow the response to tickets the orchestrator
  // can actually act on:
  //   1. Assignee: the API key's own viewer. groundcrew is a single-user
  //      orchestrator — every ticket it dispatches is "this user's work."
  //   2. Label: at least one `agent-*` label — i.e. the user opted the
  //      ticket in to groundcrew. Without this, every human-owned ticket
  //      would round-trip back just to be filtered out client-side.
  //   3. State type: scoped to actionable values (`unstarted`, `started`,
  //      `completed`, `canceled`, `duplicate`) so backlog/triage tickets never
  //      make it into the page.
  // The client-side `isGroundcrewIssue` guard in dispatcher.ts is
  // belt-and-suspenders against query drift, not the load-bearing filter.
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
  return AGENT_ANY_MODEL;
}

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

function buildLinearIssue(input: {
  identifier: string;
  uuid: string;
  title: string;
  status: string;
  statusId: string;
  stateType: string;
  assigneeName: string | undefined;
  updatedAt: string;
  repository: string | undefined;
  model: string | undefined;
  teamId: string;
  inverseRelations: { nodes: IssueRelationNode[]; pageInfo: { hasNextPage: boolean } } | undefined;
}): Issue {
  return {
    id: input.identifier.toLowerCase(),
    uuid: input.uuid,
    title: input.title,
    status: input.status,
    statusId: input.statusId,
    stateType: input.stateType,
    /* v8 ignore next @preserve -- BoardIssues query filters to assignee=isMe so a missing assignee can't occur in practice */
    assignee: input.assigneeName ?? "Unassigned",
    updatedAt: input.updatedAt,
    repository: input.repository,
    model: input.model,
    teamId: input.teamId,
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
  // description was edited or knownRepositories changed after dispatch.
  const { repository, model } = resolveTodoAgentMetadata({
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
    inverseRelations: node.inverseRelations,
  });
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
        team { id }
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
      team?: { id: string } | null;
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
    /* v8 ignore next @preserve -- ResolveIssue query selects team.id; null only if Linear genuinely returns a teamless ticket */
    teamId: issue.team?.id ?? "",
    labels: issue.labels.nodes,
    /* v8 ignore next @preserve -- ResolveIssue query selects state; null only if Linear genuinely returns a stateless ticket */
    stateName: issue.state?.name ?? "",
    /* v8 ignore next @preserve -- ResolveIssue query selects state; null only if Linear genuinely returns a stateless ticket */
    stateType: issue.state?.type ?? "",
    blockers: blockersFromRelations(issue.inverseRelations?.nodes ?? []),
    hasMoreBlockers: issue.inverseRelations?.pageInfo.hasNextPage ?? false,
    hasChildren: (issue.children?.nodes.length ?? 0) > 0,
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
 * instead of a sentinel that downstream code can't interpret.
 */
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
      stateType: relation.issue?.state?.type,
    }));
}
