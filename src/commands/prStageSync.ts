/**
 * Per-tick sync that paints each tracked task's cmux sidebar with its ticket
 * id, and — when `cmux.prStages.enabled` — its pull request's review stage
 * and gating labels too. Replaces the standalone `crew-pr-stages` bash
 * poller: same stage/ticket derivation rules (`../lib/prStageRules.ts`),
 * same status-key contract the installed sidebar reads, but PRs are
 * resolved from the task's own worktree branch
 * (`findPullRequestsForBranchOrThrow`) instead of cmux's own git-branch PR
 * detection.
 *
 * `crew_ticket` is written for every matched cmux task workspace regardless
 * of the `cmux.prStages.enabled` opt-in, since a custom sidebar may read it
 * independent of PR-stage sync; the opt-in only gates the `gh`-backed stage
 * and label writes (and the `crew_poller_heartbeat` that signals they're
 * running).
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
import { findPullRequestsForBranchOrThrow, type PullRequestSummary } from "../lib/pullRequests.ts";
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
  /** Orchestrator `--dry-run`; only `runOnce` honors it — `syncOnce` (`crew stage refresh`) always writes. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface PrStageSync {
  /**
   * The orchestrator tick step. A dry run skips everything. Otherwise
   * `crew_ticket` is always written for matched cmux task workspaces; stage,
   * labels, and the heartbeat are additionally synced only when
   * `config.cmux.prStages.enabled` is true.
   */
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

interface WriteTicketFieldArguments {
  workspace: CmuxWorkspaceSummary;
  current: ReadonlyMap<string, string>;
  deps: Pick<PrStageSyncDeps, "writeCmuxStatus">;
  signal: AbortSignal | undefined;
  counters: SyncCounters;
}

/**
 * The ticket field is derived from the workspace's own title/cwd, so it
 * needs no PR lookup and is written for every matched cmux task workspace —
 * including when `cmux.prStages.enabled` is false, so the sidebar's
 * `crew_ticket` read works for everyone regardless of the PR-stage opt-in.
 */
async function writeTicketField(arguments_: WriteTicketFieldArguments): Promise<void> {
  const { workspace, current, deps, signal, counters } = arguments_;
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
}

interface SyncWorkspaceArguments {
  match: MatchedWorkspace;
  labelNames: PrStageLabelNames;
  pullRequest: PullRequestSummary | undefined;
  pullRequestLookupFailed: boolean;
  detail: PullRequestDetail | undefined;
  deps: Pick<PrStageSyncDeps, "readCmuxStatus" | "writeCmuxStatus">;
  signal: AbortSignal | undefined;
  counters: SyncCounters;
}

/**
 * Stage and labels are cleared only when the branch is confirmed to have no
 * PR; when discovery itself failed (network/auth error) or a PR exists but
 * its detail couldn't be (re)confirmed this tick (a failed or partial
 * GraphQL batch), they are left exactly as they were — never guessed, never
 * cleared.
 */
async function syncWorkspace(arguments_: SyncWorkspaceArguments): Promise<void> {
  const {
    match,
    labelNames,
    pullRequest,
    pullRequestLookupFailed,
    detail,
    deps,
    signal,
    counters,
  } = arguments_;
  const { workspace } = match;
  const current = await deps.readCmuxStatus(workspace.id, signal);

  await writeTicketField({ workspace, current, deps, signal, counters });

  if (pullRequestLookupFailed) {
    counters.skipped += 2;
    return;
  }

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

interface PullRequestLookupResult {
  byWorkspace: Map<string, PullRequestSummary | undefined>;
  failedWorkspaceIds: Set<string>;
}

async function resolvePullRequestsByWorkspace(arguments_: {
  matches: readonly MatchedWorkspace[];
  config: ResolvedConfig;
  findPullRequests: FindPullRequests;
  signal: AbortSignal | undefined;
}): Promise<PullRequestLookupResult> {
  const { matches, config, findPullRequests, signal } = arguments_;
  const byWorkspace = new Map<string, PullRequestSummary | undefined>();
  const failedWorkspaceIds = new Set<string>();
  for (const match of matches) {
    // oxlint-disable-next-line no-await-in-loop -- one gh lookup per matched workspace; mirrors reviewer.ts's sequential PR lookups
    const branchName = await effectiveBranchName({ config, entry: match.entry });
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const pullRequests = await findPullRequests({
        cwd: match.entry.dir,
        branchName,
        ...(signal === undefined ? {} : { signal }),
      });
      byWorkspace.set(match.workspace.id, selectTrackedPullRequest(pullRequests));
    } catch (error) {
      debug(`pr-stage-sync: PR lookup failed for ${match.entry.task}: ${errorMessage(error)}`);
      failedWorkspaceIds.add(match.workspace.id);
    }
  }
  return { byWorkspace, failedWorkspaceIds };
}

/**
 * Prefers the watch loop's own cmux workspace (`$CMUX_WORKSPACE_ID`), so the
 * heartbeat sits on a workspace the user can see even when it tracks no
 * task itself. When the watch loop runs outside a cmux-spawned shell (a
 * background daemon, say) that variable is unset, so this falls back to the
 * first matched task workspace instead of silently writing no heartbeat at
 * all — a sidebar that gates "is PR-stage sync even running" on heartbeat
 * presence would otherwise read a fully-working sync as never having run.
 */
async function writeHeartbeat(arguments_: {
  matches: readonly MatchedWorkspace[];
  writeStatus: WriteCmuxStatus;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const targetWorkspaceId =
    readEnvironmentVariable(CMUX_WORKSPACE_ID_ENV) ?? arguments_.matches[0]?.workspace.id;
  if (targetWorkspaceId === undefined) {
    return;
  }
  const epochSeconds = String(Math.floor(Date.now() / 1000));
  await arguments_.writeStatus(
    targetWorkspaceId,
    { key: HEARTBEAT_KEY, priority: HEARTBEAT_PRIORITY, value: epochSeconds },
    arguments_.signal,
  );
}

const TICKETS_ONLY_FLOW = "pr-stage-sync.tickets-only";

export function createPrStageSync(deps: PrStageSyncDeps): PrStageSync {
  /**
   * Runs when `cmux.prStages.enabled` is false: writes only `crew_ticket` for
   * each matched task workspace, with no `gh` lookups, no stage/label
   * writes, and no `crew_poller_heartbeat` — the absence of any heartbeat is
   * exactly what tells the sidebar the PR-stage feature is off, so it must
   * never be written from this path.
   */
  async function syncTicketsOnly(arguments_: PrStageSyncTickArgs): Promise<void> {
    const { worktreeEntries, signal } = arguments_;

    if (!(await deps.isCmuxAdapterActive(signal))) {
      return;
    }

    debug("pr-stage-sync: starting (tickets-only, cmux.prStages disabled)");
    const counters = newCounters();
    let outcome: "updated" | "error" = "updated";
    let reason: string | undefined;

    try {
      const workspaces = await deps.listCmuxWorkspaces(signal);
      if (workspaces === undefined) {
        logEvent(TICKETS_ONLY_FLOW, { outcome: "error", reason: "workspace_list_failed" });
        return;
      }

      const matches = matchWorkspacesToTasks(workspaces, worktreeEntries);
      for (const match of matches) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential per workspace, mirrors syncOnce
          const current = await deps.readCmuxStatus(match.workspace.id, signal);
          // oxlint-disable-next-line no-await-in-loop -- sequential per workspace, mirrors syncOnce
          await writeTicketField({ workspace: match.workspace, current, deps, signal, counters });
        } catch (error) {
          outcome = "error";
          reason = "status_write_failed";
          debug(
            `pr-stage-sync: ticket write failed for ${match.entry.task}: ${errorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      outcome = "error";
      reason = errorMessage(error);
    }

    logEvent(TICKETS_ONLY_FLOW, {
      outcome,
      written: counters.written,
      cleared: counters.cleared,
      skipped: counters.skipped,
      ...(reason === undefined ? {} : { reason }),
    });
  }

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
      const { byWorkspace: pullRequestByWorkspace, failedWorkspaceIds } =
        await resolvePullRequestsByWorkspace({
          matches,
          config,
          findPullRequests: deps.findPullRequests,
          signal,
        });
      if (failedWorkspaceIds.size > 0) {
        outcome = "error";
        reason = "pull_request_lookup_failed";
      }

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
            pullRequestLookupFailed: failedWorkspaceIds.has(match.workspace.id),
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

      try {
        await writeHeartbeat({ matches, writeStatus: deps.writeCmuxStatus, signal });
      } catch (error) {
        // A heartbeat failure is reported only when nothing else already
        // flagged this pass as an error, so it never masks a more specific
        // reason (like a per-workspace status_write_failed) from an earlier
        // step in the same pass.
        if (outcome !== "error") {
          outcome = "error";
          reason = "heartbeat_write_failed";
        }
        debug(`pr-stage-sync: heartbeat write failed: ${errorMessage(error)}`);
      }
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
    if (arguments_.dryRun === true) {
      logEvent(FLOW, { outcome: "skipped", reason: "dry_run" });
      return;
    }
    if (!deps.config.cmux.prStages.enabled) {
      await syncTicketsOnly(arguments_);
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
    findPullRequests: findPullRequestsForBranchOrThrow,
    fetchPullRequestDetails,
    listCmuxWorkspaces: listCmuxWorkspaceSummaries,
    readCmuxStatus,
    writeCmuxStatus,
    isCmuxAdapterActive: async (signal) => await isCmuxAdapterActive(config, signal),
  };
}
