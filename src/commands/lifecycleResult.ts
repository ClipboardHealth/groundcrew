import { writeOutput } from "../lib/util.ts";

export type LifecycleState =
  | "provisioning"
  | "running"
  | "interrupted"
  | "resumed"
  | "failed-to-launch"
  | "absent"
  | "unknown";

export interface LifecycleTaskIdentity {
  /** Lower-cased local lifecycle key used for worktrees and workspaces. */
  id: string;
  /** Source-qualified task id, when task resolution or persisted state supplies it. */
  canonicalId?: string;
  url?: string;
}

export interface LifecycleProblem {
  /** Stable machine-readable code. Consumers must tolerate codes added in later releases. */
  code: string;
  message: string;
}

export interface LifecycleWorkspaceResource {
  name: string;
  accessCommand?: string;
}

export interface LifecycleResources {
  repository?: string;
  branch?: string;
  worktreeDir?: string;
  workspace?: LifecycleWorkspaceResource;
  agent?: string;
  worktreePreparation?: "skip";
}

export interface CleanupWorktreeResource {
  repository: string;
  branch: string;
  worktreeDir: string;
  removed: boolean;
}

export interface CleanupWorkspaceResource {
  name: string;
  closed: boolean;
}

export interface CleanupResources {
  worktrees: CleanupWorktreeResource[];
  workspaces: CleanupWorkspaceResource[];
}

export interface StartResult {
  action: "start";
  task: LifecycleTaskIdentity;
  outcome: "started" | "already-running" | "dry-run" | "partial" | "conflict";
  state: LifecycleState;
  resources: LifecycleResources;
  problems: LifecycleProblem[];
}

export interface StopResult {
  action: "stop";
  task: LifecycleTaskIdentity;
  outcome:
    | "stopped"
    | "already-stopped"
    | "workspace-missing"
    | "not-found"
    | "partial"
    | "conflict";
  state: LifecycleState;
  resources: LifecycleResources;
  problems: LifecycleProblem[];
}

export interface ResumeResult {
  action: "resume";
  task: LifecycleTaskIdentity;
  outcome: "resumed" | "already-running" | "not-found" | "partial" | "conflict";
  state: LifecycleState;
  resources: LifecycleResources;
  problems: LifecycleProblem[];
}

export interface CleanupResult {
  action: "cleanup";
  task: LifecycleTaskIdentity;
  outcome: "cleaned" | "nothing-to-clean" | "state-cleared" | "refused" | "partial" | "conflict";
  state: LifecycleState;
  resources: CleanupResources;
  problems: LifecycleProblem[];
}

export type LifecycleResult = StartResult | StopResult | ResumeResult | CleanupResult;

export const LIFECYCLE_PROBLEM_CODES = {
  cancelled: "cancelled",
  lifecycleLockHeld: "lifecycle-lock-held",
  taskStatusUpdateFailed: "task-status-update-failed",
  stateWriteFailed: "state-write-failed",
  workspaceBusy: "workspace-busy",
  workspaceConflict: "workspace-conflict",
  workspaceStatusUnavailable: "workspace-status-unavailable",
  worktreeConflict: "worktree-conflict",
  worktreeDirty: "worktree-dirty",
  worktreeStatusUnknown: "worktree-status-unknown",
  workspaceCloseFailed: "workspace-close-failed",
  worktreeRemoveFailed: "worktree-remove-failed",
} as const;

export function lifecycleResultExitCode(result: LifecycleResult): 0 | 1 {
  if (
    result.outcome === "partial" ||
    result.outcome === "conflict" ||
    result.outcome === "refused"
  ) {
    return 1;
  }
  return 0;
}

export function renderLifecycleResult(arguments_: {
  result: LifecycleResult;
  json: boolean;
}): void {
  const { result, json } = arguments_;
  if (json) {
    writeOutput(JSON.stringify(result));
    return;
  }
  renderHumanResult(result);
}

function renderHumanResult(result: LifecycleResult): void {
  if (result.action === "start") {
    renderStartResult(result);
    return;
  }
  if (result.action === "stop") {
    renderStopResult(result);
    return;
  }
  if (result.action === "resume") {
    renderResumeResult(result);
    return;
  }
  renderCleanupResult(result);
}

function renderStartResult(result: StartResult): void {
  const { id } = result.task;
  if (result.outcome === "started") {
    const agent = result.resources.agent === undefined ? "" : ` (${result.resources.agent})`;
    const worktree =
      result.resources.worktreeDir === undefined
        ? ""
        : `  worktree ${result.resources.worktreeDir}`;
    writeOutput(`✓ "${id}" launched${agent}${worktree}`);
  } else if (result.outcome === "already-running") {
    writeOutput(`Task ${id} is already running; no changes made.`);
  } else if (result.outcome === "dry-run") {
    const repository = result.resources.repository ?? "the resolved repository";
    const agent = result.resources.agent ?? "the resolved agent";
    const preparation =
      result.resources.worktreePreparation === "skip" ? "; prepareWorktree skipped" : "";
    writeOutput(`[dry-run] Would launch ${id} in ${repository} (${agent})${preparation}`);
  } else {
    writeOutcomeWithProblems("Start", id, result.outcome, result.problems);
  }
  renderAccessCommand(result.resources.workspace);
}

function renderStopResult(result: StopResult): void {
  const { id } = result.task;
  if (result.outcome === "stopped") {
    const suffix =
      result.resources.worktreeDir === undefined
        ? ""
        : `; worktree preserved at ${result.resources.worktreeDir}`;
    writeOutput(`Interrupted ${id}${suffix}`);
    writeOutput(`Next: crew status ${id}`);
    return;
  }
  if (result.outcome === "already-stopped" || result.outcome === "workspace-missing") {
    writeOutput(`Workspace for ${id} is already absent; local context was preserved.`);
    return;
  }
  if (result.outcome === "not-found") {
    writeOutput(`No run state, worktree, or live workspace found for ${id}; nothing to stop.`);
    return;
  }
  writeOutcomeWithProblems("Stop", id, result.outcome, result.problems);
}

function renderResumeResult(result: ResumeResult): void {
  const { id } = result.task;
  if (result.outcome === "resumed") {
    const directory =
      result.resources.worktreeDir === undefined ? "" : ` in ${result.resources.worktreeDir}`;
    const agent = result.resources.agent === undefined ? "" : ` (${result.resources.agent})`;
    writeOutput(`Resumed ${id}${directory}${agent}`);
  } else if (result.outcome === "already-running") {
    writeOutput(`Workspace for ${id} is already live; no changes made.`);
  } else if (result.outcome === "not-found") {
    writeOutput(`No worktree found for ${id}; cannot resume.`);
  } else {
    writeOutcomeWithProblems("Resume", id, result.outcome, result.problems);
  }
  renderAccessCommand(result.resources.workspace);
}

function renderCleanupResult(result: CleanupResult): void {
  const { id } = result.task;
  if (result.outcome === "nothing-to-clean") {
    writeOutput(`No worktree found for ${id}; nothing to clean up.`);
    return;
  }
  if (result.outcome === "state-cleared") {
    writeOutput(`No worktree found for ${id}; cleared stale run-state.`);
    return;
  }
  for (const workspace of result.resources.workspaces) {
    if (workspace.closed) {
      writeOutput(`Closed workspace ${workspace.name}`);
    }
  }
  for (const worktree of result.resources.worktrees) {
    if (worktree.removed) {
      writeOutput(`✓ Cleanup complete for ${id} (host)`);
      writeOutput(`  Worktree: ${worktree.worktreeDir} (removed)`);
    }
  }
  if (result.outcome !== "cleaned") {
    writeOutcomeWithProblems("Cleanup", id, result.outcome, result.problems);
  }
}

function renderAccessCommand(workspace: LifecycleWorkspaceResource | undefined): void {
  if (workspace?.accessCommand !== undefined) {
    writeOutput(`Attach: ${workspace.accessCommand}`);
  }
}

function writeOutcomeWithProblems(
  action: string,
  task: string,
  outcome: string,
  problems: readonly LifecycleProblem[],
): void {
  const detail =
    problems.length === 0 ? "" : `: ${problems.map((problem) => problem.message).join("; ")}`;
  writeOutput(`${action} ${outcome} for ${task}${detail}`);
}
