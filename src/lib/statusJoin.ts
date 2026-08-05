/**
 * Combines the local and remote status tiers at read time. Lives apart from
 * the collectors because an external monitor reimplements this step against
 * the published documents, and the text renderer consumes its output.
 */

import type { PullRequestSummary } from "./pullRequests.ts";
import type {
  LocalStatusDocument,
  RemoteStatusDocument,
  StatusBlockedIssue,
  StatusBoardIssue,
  StatusQueueIssue,
  StatusTask,
  StatusWorktree,
} from "./statusSnapshot.ts";
import type { CanonicalStatus } from "./taskSource.ts";

export interface JoinedWorktree extends StatusWorktree {
  pullRequests: PullRequestSummary[];
}

export interface JoinedTask extends Omit<StatusTask, "worktrees"> {
  boardStatus: CanonicalStatus | undefined;
  worktrees: JoinedWorktree[];
}

export interface JoinedSlots {
  used: number;
  maximum: number;
}

export interface JoinedStatus {
  tasks: JoinedTask[];
  /** In-progress board issues with no local worktree. */
  inProgressWithoutWorktree: StatusBoardIssue[];
  queueReady: StatusQueueIssue[];
  queueBlocked: StatusBlockedIssue[];
  /** Undefined when no board fetch has ever succeeded. */
  slots: JoinedSlots | undefined;
}

export interface JoinStatusInput {
  local: LocalStatusDocument;
  remote: RemoteStatusDocument | undefined;
}

/**
 * The board lists arrive unsubtracted, so this is where the local worktree set
 * is removed from them. Doing it here rather than at fetch time is what keeps
 * a fast local poll paired with a slow board poll from reporting a
 * just-dispatched task as still queued.
 */
export function joinStatus(input: JoinStatusInput): JoinedStatus {
  const { local, remote } = input;
  const payload = remote?.payload;

  const tasks: JoinedTask[] = local.tasks.map((task) => ({
    ...task,
    boardStatus: ownProperty(payload?.statusByTask, task.task),
    worktrees: task.worktrees.map((worktree) => ({
      ...worktree,
      pullRequests: ownProperty(remote?.pullRequestsByWorktree, worktree.dir) ?? [],
    })),
  }));

  if (payload === undefined) {
    return {
      tasks,
      inProgressWithoutWorktree: [],
      queueReady: [],
      queueBlocked: [],
      slots: undefined,
    };
  }

  const localTasks = new Set(local.tasks.map((task) => task.task));
  return {
    tasks,
    inProgressWithoutWorktree: withoutLocalWorktree(payload.inProgress, localTasks),
    queueReady: withoutLocalWorktree(payload.queueReady, localTasks),
    queueBlocked: withoutLocalWorktree(payload.queueBlocked, localTasks),
    // Every in-progress issue holds a slot, including ones that do have a
    // local worktree, so this counts the unsubtracted list.
    slots: { used: payload.inProgress.length, maximum: local.maximumInProgress },
  };
}

/**
 * These records arrive from JSON, so they carry Object.prototype. A task named
 * "constructor" would otherwise resolve to a prototype member rather than a
 * miss, and the renderer would print it.
 */
function ownProperty<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return record[key];
}

function withoutLocalWorktree<T extends StatusBoardIssue>(
  issues: readonly T[],
  localTasks: ReadonlySet<string>,
): T[] {
  return issues.filter((issue) => !localTasks.has(issue.naturalId.toLowerCase()));
}
