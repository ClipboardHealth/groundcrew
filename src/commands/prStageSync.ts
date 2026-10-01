/**
 * Per-tick sync that paints each tracked task's cmux sidebar with its pull
 * request's review stage, gating labels, and ticket id. Replaces the
 * standalone `crew-pr-stages` bash poller: same stage/ticket derivation
 * rules (`../lib/prStageRules.ts`), same status-key contract the installed
 * sidebar reads, but PRs are resolved from the task's own worktree branch
 * (`findPullRequestsForBranch`) instead of cmux's own git-branch PR
 * detection.
 *
 * Runs after the other tick steps in `orchestrator.ts`. Every failure is
 * caught and logged here — a flaky `gh` call or a single misbehaving
 * workspace must never break the watch loop or starve the other steps.
 */

import { type CmuxWorkspaceSummary, listCmuxWorkspaceSummaries } from "../lib/cmuxAdapter.ts";
import { type CmuxStatusWrite, readCmuxStatus, writeCmuxStatus } from "../lib/cmuxStatusFields.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities } from "../lib/host.ts";
import { fetchPullRequestDetails, type PullRequestDetail } from "../lib/pullRequestDetails.ts";
import { findPullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import {
  deriveTicket,
  derivePrStage,
  managedLabelsField,
  type PrStageLabelNames,
} from "../lib/prStageRules.ts";
import { debug, errorMessage, logEvent, readEnvironmentVariable } from "../lib/util.ts";
import { resolveWorkspaceKind } from "../lib/workspaces.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import { effectiveBranchName } from "../lib/worktreeRunState.ts";

const FLOW = "pr-stage-sync";

const STAGE_KEY = "crew_stage";
const STAGE_PRIORITY = -10;
const TICKET_KEY = "crew_ticket";
const TICKET_PRIORITY = -11;
const HEARTBEAT_KEY = "crew_poller_heartbeat";
const HEARTBEAT_PRIORITY = -12;
const LABELS_KEY = "crew_labels";
const LABELS_PRIORITY = -13;

const CMUX_WORKSPACE_ID_ENV = "CMUX_WORKSPACE_ID";

export type FindPullRequests = (arguments_: {
  cwd: string;
  branchName: string;
  signal?: AbortSignal;
}) => Promise<readonly PullRequestSummary[]>;

export type FetchPullRequestDetails = (arguments_: {
  urls: readonly string[];
  signal?: AbortSignal;
}) => Promise<Map<string, PullRequestDetail | undefined>>;

export type ListCmuxWorkspaces = (
  signal?: AbortSignal,
) => Promise<CmuxWorkspaceSummary[] | undefined>;
export type ReadCmuxStatus = (
  workspaceId: string,
  signal?: AbortSignal,
) => Promise<Map<string, string>>;
export type WriteCmuxStatus = (
  workspaceId: string,
  write: CmuxStatusWrite,
  signal?: AbortSignal,
) => Promise<void>;
export type IsCmuxAdapterActive = (signal?: AbortSignal) => Promise<boolean>;

export interface PrStageSyncDeps {
  config: ResolvedConfig;
  findPullRequests: FindPullRequests;
  fetchPullRequestDetails: FetchPullRequestDetails;
  listCmuxWorkspaces: ListCmuxWorkspaces;
  readCmuxStatus: ReadCmuxStatus;
  writeCmuxStatus: WriteCmuxStatus;
  isCmuxAdapterActive: IsCmuxAdapterActive;
}

export interface PrStageSyncTickArgs {
  worktreeEntries: readonly WorktreeEntry[];
  signal?: AbortSignal;
}

export interface PrStageSync {
  /** Gated on `config.cmux.prStages.enabled` — the orchestrator tick step. */
  runOnce: (arguments_: PrStageSyncTickArgs) => Promise<void>;
  /** Ungated (still requires the cmux adapter): `crew stage refresh` and the label CLI's trailing sync. */
  syncOnce: (arguments_: PrStageSyncTickArgs) => Promise<void>;
}

/** Whether the resolved workspace backend for this config is cmux — every other adapter no-ops. */
export async function isCmuxAdapterActive(
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const { resolved } = resolveWorkspaceKind({
      config,
      host: await detectHostCapabilities(signal),
    });
    return resolved === "cmux";
  } catch {
    return false;
  }
}

interface MatchedWorkspace {
  workspace: CmuxWorkspaceSummary;
  entry: WorktreeEntry;
}

/**
 * Only cmux workspaces groundcrew created for a task are in scope: resolving
 * a PR "from the task's worktree branch" presupposes a task. A cmux pane the
 * user opened by hand has neither — it is left exactly as untouched as
 * before this feature existed, rather than guessed at. The workspace's
 * reported cwd is the precise match (handles multi-repo tasks); the task-id
 * marker is the fallback for a workspace cmux hasn't reported a cwd for yet.
 */
function matchWorkspacesToTasks(
  workspaces: readonly CmuxWorkspaceSummary[],
  worktreeEntries: readonly WorktreeEntry[],
): MatchedWorkspace[] {
  const matches: MatchedWorkspace[] = [];
  for (const workspace of workspaces) {
    const entry =
      worktreeEntries.find((candidate) => candidate.dir === workspace.currentDirectory) ??
      worktreeEntries.find((candidate) => candidate.task === workspace.taskId);
    if (entry !== undefined) {
      matches.push({ workspace, entry });
    }
  }
  return matches;
}

/** One PR to track per workspace: prefer a live one, then whichever terminal state, else whatever gh returned first. */
function selectTrackedPullRequest(
  pullRequests: readonly PullRequestSummary[],
): PullRequestSummary | undefined {
  return (
    pullRequests.find((pr) => pr.state === "open") ??
    pullRequests.find((pr) => pr.state === "merged") ??
    pullRequests.find((pr) => pr.state === "closed") ??
    pullRequests[0]
  );
}

interface SyncCounters {
  written: number;
  cleared: number;
  skipped: number;
}

function newCounters(): SyncCounters {
  return { written: 0, cleared: 0, skipped: 0 };
}

async function applyField(arguments_: {
  workspaceId: string;
  key: string;
  priority: number;
  current: string;
  desired: string;
  signal: AbortSignal | undefined;
  writeStatus: WriteCmuxStatus;
  counters: SyncCounters;
}): Promise<void> {
  const { workspaceId, key, priority, current, desired, signal, writeStatus, counters } =
    arguments_;
  if (desired === current) {
    counters.skipped += 1;
    return;
  }
  await writeStatus(workspaceId, { key, priority, value: desired }, signal);
  if (desired.length === 0) {
    counters.cleared += 1;
  } else {
    counters.written += 1;
  }
}

interface SyncWorkspaceArguments {
  match: MatchedWorkspace;
  labelNames: PrStageLabelNames;
  pullRequest: PullRequestSummary | undefined;
  detail: PullRequestDetail | undefined;
  deps: Pick<PrStageSyncDeps, "readCmuxStatus" | "writeCmuxStatus">;
  signal: AbortSignal | undefined;
  counters: SyncCounters;
}

/**
 * The ticket field is independent of PR resolution (derived from the
 * workspace's own title/cwd) and is always applied. Stage and labels are
 * cleared only when the branch genuinely has no PR; when a PR exists but its
 * detail couldn't be (re)confirmed this tick (a failed or partial GraphQL
 * batch), they are left exactly as they were — never guessed, never cleared.
 */
async function syncWorkspace(arguments_: SyncWorkspaceArguments): Promise<void> {
  const { match, labelNames, pullRequest, detail, deps, signal, counters } = arguments_;
  const { workspace } = match;
  const current = await deps.readCmuxStatus(workspace.id, signal);

  await applyField({
    workspaceId: workspace.id,
    key: TICKET_KEY,
    priority: TICKET_PRIORITY,
    current: current.get(TICKET_KEY) ?? "",
    desired:
      deriveTicket({
        title: workspace.title,
        ...(workspace.currentDirectory === undefined
          ? {}
          : { currentDirectory: workspace.currentDirectory }),
      }) ?? "",
    signal,
    writeStatus: deps.writeCmuxStatus,
    counters,
  });

  if (pullRequest === undefined) {
    await applyField({
      workspaceId: workspace.id,
      key: STAGE_KEY,
      priority: STAGE_PRIORITY,
      current: current.get(STAGE_KEY) ?? "",
      desired: "",
      signal,
      writeStatus: deps.writeCmuxStatus,
      counters,
    });
    await applyField({
      workspaceId: workspace.id,
      key: LABELS_KEY,
      priority: LABELS_PRIORITY,
      current: current.get(LABELS_KEY) ?? "",
      desired: "",
      signal,
      writeStatus: deps.writeCmuxStatus,
      counters,
    });
    return;
  }

  if (detail === undefined) {
    counters.skipped += 2;
    return;
  }

  await applyField({
    workspaceId: workspace.id,
    key: STAGE_KEY,
    priority: STAGE_PRIORITY,
    current: current.get(STAGE_KEY) ?? "",
    desired: derivePrStage(detail, labelNames),
    signal,
    writeStatus: deps.writeCmuxStatus,
    counters,
  });
  await applyField({
    workspaceId: workspace.id,
    key: LABELS_KEY,
    priority: LABELS_PRIORITY,
    current: current.get(LABELS_KEY) ?? "",
    desired: managedLabelsField(detail.labels, labelNames),
    signal,
    writeStatus: deps.writeCmuxStatus,
    counters,
  });
}

async function resolvePullRequestsByWorkspace(arguments_: {
  matches: readonly MatchedWorkspace[];
  config: ResolvedConfig;
  findPullRequests: FindPullRequests;
  signal: AbortSignal | undefined;
}): Promise<Map<string, PullRequestSummary | undefined>> {
  const { matches, config, findPullRequests, signal } = arguments_;
  const result = new Map<string, PullRequestSummary | undefined>();
  for (const match of matches) {
    // oxlint-disable-next-line no-await-in-loop -- one gh lookup per matched workspace; mirrors reviewer.ts's sequential PR lookups
    const branchName = await effectiveBranchName({ config, entry: match.entry });
    let pullRequests: readonly PullRequestSummary[];
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      pullRequests = await findPullRequests({
        cwd: match.entry.dir,
        branchName,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      debug(`pr-stage-sync: PR lookup failed for ${match.entry.task}: ${errorMessage(error)}`);
      pullRequests = [];
    }
    result.set(match.workspace.id, selectTrackedPullRequest(pullRequests));
  }
  return result;
}

async function writeHeartbeat(arguments_: {
  writeStatus: WriteCmuxStatus;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const ownWorkspaceId = readEnvironmentVariable(CMUX_WORKSPACE_ID_ENV);
  if (ownWorkspaceId === undefined) {
    return;
  }
  const epochSeconds = String(Math.floor(Date.now() / 1000));
  await arguments_.writeStatus(
    ownWorkspaceId,
    { key: HEARTBEAT_KEY, priority: HEARTBEAT_PRIORITY, value: epochSeconds },
    arguments_.signal,
  );
}

export function createPrStageSync(deps: PrStageSyncDeps): PrStageSync {
  async function syncOnce(arguments_: PrStageSyncTickArgs): Promise<void> {
    const { worktreeEntries, signal } = arguments_;
    const { config } = deps;

    if (!(await deps.isCmuxAdapterActive(signal))) {
      return;
    }

    debug("pr-stage-sync: starting");
    const counters = newCounters();
    let outcome: "updated" | "error" = "updated";
    let reason: string | undefined;

    try {
      const workspaces = await deps.listCmuxWorkspaces(signal);
      if (workspaces === undefined) {
        logEvent(FLOW, { outcome: "error", reason: "workspace_list_failed" });
        return;
      }

      const matches = matchWorkspacesToTasks(workspaces, worktreeEntries);
      const pullRequestByWorkspace = await resolvePullRequestsByWorkspace({
        matches,
        config,
        findPullRequests: deps.findPullRequests,
        signal,
      });

      const urls = [
        ...new Set(
          [...pullRequestByWorkspace.values()].flatMap((pr) => (pr === undefined ? [] : [pr.url])),
        ),
      ];
      let details = new Map<string, PullRequestDetail | undefined>();
      if (urls.length > 0) {
        try {
          details = await deps.fetchPullRequestDetails({
            urls,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          outcome = "error";
          reason = "pull_request_detail_lookup_failed";
          debug(`pr-stage-sync: PR detail lookup failed: ${errorMessage(error)}`);
        }
      }

      for (const match of matches) {
        const pullRequest = pullRequestByWorkspace.get(match.workspace.id);
        const detail = pullRequest === undefined ? undefined : details.get(pullRequest.url);
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential per workspace so one workspace's status calls never interleave with another's
          await syncWorkspace({
            match,
            labelNames: config.cmux.prStages.labels,
            pullRequest,
            detail,
            deps,
            signal,
            counters,
          });
        } catch (error) {
          outcome = "error";
          reason = "status_write_failed";
          debug(`pr-stage-sync: sync failed for ${match.entry.task}: ${errorMessage(error)}`);
        }
      }

      await writeHeartbeat({ writeStatus: deps.writeCmuxStatus, signal });
    } catch (error) {
      outcome = "error";
      reason = errorMessage(error);
    }

    logEvent(FLOW, {
      outcome,
      written: counters.written,
      cleared: counters.cleared,
      skipped: counters.skipped,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async function runOnce(arguments_: PrStageSyncTickArgs): Promise<void> {
    if (!deps.config.cmux.prStages.enabled) {
      return;
    }
    await syncOnce(arguments_);
  }

  return { runOnce, syncOnce };
}

/** Wires the real cmux/gh-backed implementations behind `PrStageSyncDeps`. */
export function createPrStageSyncDeps(config: ResolvedConfig): PrStageSyncDeps {
  return {
    config,
    findPullRequests: findPullRequestsForBranch,
    fetchPullRequestDetails,
    listCmuxWorkspaces: listCmuxWorkspaceSummaries,
    readCmuxStatus,
    writeCmuxStatus,
    isCmuxAdapterActive: async (signal) => await isCmuxAdapterActive(config, signal),
  };
}
