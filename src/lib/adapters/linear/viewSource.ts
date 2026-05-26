import type { LinearClient } from "@linear/sdk";

import {
  AGENT_LABEL_PREFIX,
  type Blocker as LinearBlocker,
  type BoardSource,
  type BoardState as LinearBoardState,
  buildLinearIssue,
  ISSUES_PAGE_SIZE,
  type Issue as LinearIssue,
  type IssueRelationNode,
  type ParentSkip,
  resolveAgentMetadata,
  resolveModelFor,
  resolveTodoAgentMetadata,
  warnIfDisabledFallback,
} from "../../boardSource.ts";
import type { ResolvedConfig, ResolvedViewConfig } from "../../config.ts";
import type {
  Blocker as CanonicalBlocker,
  CanonicalStatus,
  Issue as CanonicalIssue,
  TicketSource,
} from "../../ticketSource.ts";
import { log } from "../../util.ts";
import {
  buildLinearCanonicalIssue,
  buildResolvedLinearCanonicalIssue,
  type LinearSourceRef,
} from "./canonical.ts";

export function canonicalStatusForStateType(stateType: string): CanonicalStatus {
  if (stateType === "unstarted") {
    return "todo";
  }
  if (stateType === "started") {
    return "in-progress";
  }
  if (stateType === "completed" || stateType === "canceled") {
    return "done";
  }
  return "other";
}

interface VerifyViewArguments {
  client: LinearClient;
  viewSlugId: string;
  viewSlug: string;
}

interface ResolvedView {
  id: string;
  name: string;
}

export async function verifyView(arguments_: VerifyViewArguments): Promise<ResolvedView> {
  const { client, viewSlugId, viewSlug } = arguments_;
  // Linear's `customView(id: ...)` accepts either the view UUID or the 12-char
  // slugId — the slugId is shorter and what users pasted from the URL.
  const response: { data?: unknown } = await client.client.rawRequest(
    `query VerifyView($id: String!) {
      customView(id: $id) { id name slugId }
    }`,
    { id: viewSlugId },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
  const { customView } = response.data as {
    customView: { id: string; name: string; slugId: string } | null;
  };
  if (customView === null) {
    throw new Error(
      `No Linear view found with slugId "${viewSlugId}" (linear.views[].viewSlug "${viewSlug}"). Check the slug, archived status, or API-key access.`,
    );
  }
  log(`Resolved Linear view: ${customView.name} (slugId ${customView.slugId})`);
  return { id: customView.id, name: customView.name };
}

function createViewUuidResolver(arguments_: VerifyViewArguments): () => Promise<string> {
  let cached: string | undefined;
  return async (): Promise<string> => {
    if (cached !== undefined) {
      return cached;
    }
    const resolved = await verifyView(arguments_);
    cached = resolved.id;
    return cached;
  };
}

export function createViewBoardSource(arguments_: {
  client: LinearClient;
  config: ResolvedConfig;
  view: ResolvedViewConfig;
}): BoardSource {
  const { client, config, view } = arguments_;
  const ensureUuid = createViewUuidResolver({
    client,
    viewSlug: view.viewSlug,
    viewSlugId: view.slugId,
  });
  return {
    async verify(): Promise<void> {
      await ensureUuid();
    },
    async fetch(): Promise<ViewBoardState> {
      const viewUuid = await ensureUuid();
      return await fetchViewBoard({ client, config, viewUuid });
    },
  };
}

interface StateLookup {
  getStateId(teamId: string): Promise<string>;
}

export function createInProgressStateLookup(deps: { client: LinearClient }): StateLookup {
  const { client } = deps;
  const cache = new Map<string, string>();
  return {
    async getStateId(teamId: string): Promise<string> {
      const cached = cache.get(teamId);
      if (cached !== undefined) {
        return cached;
      }
      const response: { data?: unknown } = await client.client.rawRequest(
        `query InProgressState($teamId: String!) {
          team(id: $teamId) {
            states(filter: { type: { eq: "started" } }) {
              nodes { id name position type }
            }
          }
        }`,
        { teamId },
      );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
      const { team } = response.data as {
        team: {
          states: { nodes: { id: string; name: string; position: number; type: string }[] };
        };
      };
      const sorted = team.states.nodes.toSorted((a, b) => a.position - b.position);
      const [first] = sorted;
      if (first === undefined) {
        throw new Error(
          `team "${teamId}" has no workflow state with type=started; cannot mark in-progress`,
        );
      }
      cache.set(teamId, first.id);
      return first.id;
    },
  };
}

interface ViewIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  assignee?: { name: string } | null;
  project?: { slugId: string } | null;
  children: { nodes: { id: string }[] };
  labels: { nodes: { name: string }[] };
  inverseRelations?: {
    nodes: IssueRelationNode[];
    pageInfo: { hasNextPage: boolean };
  };
}

interface ViewIssuesPage {
  nodes: ViewIssueNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface FetchViewBoardArguments {
  client: LinearClient;
  config: ResolvedConfig;
  viewUuid: string;
}

export interface ViewBoardState extends LinearBoardState {
  stateTypeById: Map<string, string>;
}

export async function fetchViewBoard(arguments_: FetchViewBoardArguments): Promise<ViewBoardState> {
  const { client, config, viewUuid } = arguments_;
  const nodes: ViewIssueNode[] = [];
  let after: string | null = null;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on the previous response
    const response: { data?: unknown } = await client.client.rawRequest(
      `query ViewIssues($viewId: String!, $agentLabelPrefix: String!, $after: String) {
        customView(id: $viewId) {
          id
          name
          issues(
            filter: { labels: { some: { name: { startsWith: $agentLabelPrefix } } } }
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
              project { slugId }
              children { nodes { id } }
              labels { nodes { name } }
              inverseRelations(first: 50, includeArchived: false) {
                nodes {
                  type
                  issue {
                    identifier
                    title
                    state { name type }
                    project { slugId }
                  }
                }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { viewId: viewUuid, agentLabelPrefix: AGENT_LABEL_PREFIX, after },
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by our GraphQL query above
    const { customView } = response.data as {
      customView: { issues: ViewIssuesPage } | null;
    };
    if (customView === null) {
      throw new Error(
        `Linear view uuid "${viewUuid}" disappeared mid-fetch. Verify the view still exists and the API key still has access.`,
      );
    }
    nodes.push(...customView.issues.nodes);
    if (!customView.issues.pageInfo.hasNextPage) {
      break;
    }
    after = customView.issues.pageInfo.endCursor;
  }

  const issues: LinearIssue[] = [];
  const parentSkips: ParentSkip[] = [];
  const stateTypeById = new Map<string, string>();
  for (const node of nodes) {
    if (!nodeHasAgentLabel(node)) {
      continue;
    }
    const stateType = node.state.type;
    if (stateType === "backlog" || stateType === "triage") {
      continue;
    }
    if (node.children.nodes.length > 0) {
      if (stateType === "unstarted") {
        parentSkips.push({
          id: node.identifier.toLowerCase(),
          title: node.title,
          childCount: node.children.nodes.length,
        });
      }
      continue;
    }
    const issue = issueFromViewNode(node, config);
    issues.push(issue);
    stateTypeById.set(issue.id, stateType);
  }
  return { timestamp: new Date().toISOString(), issues, parentSkips, stateTypeById };
}

function nodeHasAgentLabel(node: ViewIssueNode): boolean {
  return node.labels.nodes.some((label) => label.name.startsWith(AGENT_LABEL_PREFIX));
}

function issueFromViewNode(node: ViewIssueNode, config: ResolvedConfig): LinearIssue {
  const modelResolution = resolveModelFor({ labels: node.labels.nodes, config });
  warnIfDisabledFallback(node.identifier, modelResolution, config);
  const { repository, model } = resolveTodoAgentMetadata({
    ticket: node.identifier,
    description: node.description ?? undefined,
    modelResolution,
    config,
    isTodo: node.state.type === "unstarted",
  });
  return buildLinearIssue({
    identifier: node.identifier,
    uuid: node.id,
    title: node.title,
    status: node.state.name,
    statusId: node.state.id,
    assigneeName: node.assignee?.name,
    updatedAt: node.updatedAt,
    repository,
    model,
    teamId: node.team.id,
    projectSlugId: node.project?.slugId?.toLowerCase() ?? "",
    inverseRelations: node.inverseRelations,
  });
}

interface CreateViewTicketSourceArguments {
  client: LinearClient;
  config: ResolvedConfig;
  view: ResolvedViewConfig;
  sourceName: string;
}

export function createLinearViewTicketSource(
  arguments_: CreateViewTicketSourceArguments,
): TicketSource {
  const { client, config, view, sourceName } = arguments_;
  const stateLookup = createInProgressStateLookup({ client });
  const board = createViewBoardSource({ client, config, view });

  function toCanonicalBlocker(blocker: LinearBlocker): CanonicalBlocker {
    return {
      id: `${sourceName}:${blocker.id}`,
      title: blocker.title,
      /* v8 ignore next @preserve -- view-mode's GraphQL query always selects state.type for blockers, so stateType is defined in real runs */
      status: canonicalStatusForStateType(blocker.stateType ?? ""),
    };
  }

  function toCanonicalIssue(linearIssue: LinearIssue, stateType: string): CanonicalIssue {
    return buildLinearCanonicalIssue({
      linearIssue,
      sourceName,
      status: canonicalStatusForStateType(stateType),
      blockers: linearIssue.blockers.map(toCanonicalBlocker),
    });
  }

  return {
    name: sourceName,
    async verify(): Promise<void> {
      await board.verify();
    },
    async fetch(): Promise<CanonicalIssue[]> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createViewBoardSource always returns a ViewBoardState; the BoardSource interface widens it
      const state = (await board.fetch()) as ViewBoardState;
      return state.issues.map((issue) => {
        const stateType = state.stateTypeById.get(issue.id);
        /* v8 ignore next 3 @preserve -- fetchViewBoard contract guarantees stateType is present */
        if (stateType === undefined) {
          throw new Error(`internal: view-mode issue ${issue.id} missing stateType`);
        }
        return toCanonicalIssue(issue, stateType);
      });
    },
    async resolveOne(naturalId: string): Promise<CanonicalIssue | undefined> {
      const resolved = await resolveAgentMetadata({ client, config, ticket: naturalId });
      return buildResolvedLinearCanonicalIssue({
        sourceName,
        ticketIdentifier: naturalId,
        resolved: { ...resolved, projectSlugId: resolved.projectSlugId ?? "" },
      });
    },
    async markInProgress(issue: CanonicalIssue): Promise<void> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- by this adapter's contract every Issue carries a LinearSourceRef in sourceRef
      const ref = issue.sourceRef as LinearSourceRef;
      const stateId = await stateLookup.getStateId(ref.teamId);
      await client.updateIssue(ref.uuid, { stateId });
      log(`Marked ${issue.id} as in-progress (team ${ref.teamId}, state ${stateId})`);
    },
  };
}
