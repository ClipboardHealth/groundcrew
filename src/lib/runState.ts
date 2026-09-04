import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomicJson.ts";

import type { ResolvedConfig } from "./config.ts";
import { normalizePlainTaskId } from "./taskId.ts";

export type RunLifecycleState =
  | "provisioning"
  | "running"
  | "interrupted"
  | "resumed"
  | "failed-to-launch";

export interface RunState {
  task: string;
  repository: string;
  agent: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  state: RunLifecycleState;
  createdAt: string;
  updatedAt: string;
  resumeCount: number;
  reason?: string;
  detail?: string;
  /**
   * Task title at dispatch time. Cached so `crew status` can render it
   * without re-hitting the task source; lifecycle transitions
   * (resume/interrupt) that omit the field preserve the on-disk value.
   */
  title?: string;
  /**
   * Direct task URL at dispatch time. Same caching rationale as `title`;
   * the source adapter populates it when it can (e.g., Linear), otherwise
   * the field stays undefined and `crew status` falls back to displaying
   * just the task id.
   */
  url?: string;
  /**
   * Canonical source-prefixed id used for no-PR self-completion. Cached so
   * resumed workers keep the same completion target as the original launch.
   */
  completionTaskId?: string;
  /**
   * True when the branch was adopted from an existing local/remote branch
   * rather than created by groundcrew. Teardown must preserve such branches.
   */
  adoptedBranch?: boolean;
  /**
   * Parent branch this task's branch and PR are based on, when stacked.
   * Cleared once the child rebases onto the default branch after the
   * parent merges; `parentTask` is retained.
   */
  baseBranch?: string;
  /** Canonical id of the blocker task this task is stacked on. */
  parentTask?: string;
  /**
   * True when the parent merged, the PR was retargeted to the default
   * branch, but the worktree was dirty so the rebase was skipped.
   */
  needsRebase?: boolean;
}

export interface RunStateDraft {
  task: string;
  repository: string;
  agent: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  state: RunLifecycleState;
  reason?: string;
  detail?: string;
  resumeCount?: number;
  title?: string;
  url?: string;
  completionTaskId?: string;
  adoptedBranch?: boolean;
  baseBranch?: string;
  parentTask?: string;
  needsRebase?: boolean;
  /**
   * Optional-field names to drop entirely rather than carry forward from the
   * on-disk record. Used by the failed-to-launch path so a `baseBranch`/
   * `parentTask` written moments earlier by a "provisioning" row doesn't leak
   * into a terminal failure state (`worktreeRunState.ts`'s
   * `isReferencedAsStackParent` scans run state for exactly these fields, so
   * a leaked value would preserve the parent's branch forever).
   */
  clearFields?: ReadonlyArray<"baseBranch" | "parentTask" | "needsRebase">;
}

export interface RecordRunStateInput {
  config: ResolvedConfig;
  state: RunStateDraft;
}

export interface UpdateRunStateInput {
  config: ResolvedConfig;
  task: string;
  patch: Partial<Omit<RunState, "createdAt" | "task">> & {
    state: RunLifecycleState;
  };
}

const RUN_STATE_DIRECTORY_NAME = "runs";

function taskKey(task: string): string {
  return normalizePlainTaskId(task);
}

export function runStateDirectory(config: Pick<ResolvedConfig, "logging">): string {
  return path.resolve(path.dirname(config.logging.file), RUN_STATE_DIRECTORY_NAME);
}

export function runStatePath(config: Pick<ResolvedConfig, "logging">, task: string): string {
  return path.resolve(runStateDirectory(config), `${taskKey(task)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRunLifecycleState(value: unknown): value is RunLifecycleState {
  return (
    value === "provisioning" ||
    value === "running" ||
    value === "interrupted" ||
    value === "resumed" ||
    value === "failed-to-launch"
  );
}

function isValidResumeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

type RequiredRunStateFields = Pick<
  RunState,
  | "task"
  | "repository"
  | "agent"
  | "worktreeDir"
  | "branchName"
  | "workspaceName"
  | "state"
  | "createdAt"
  | "updatedAt"
  | "resumeCount"
>;

function parseRequiredFields(value: Record<string, unknown>): RequiredRunStateFields | undefined {
  const task = stringField(value, "task");
  const repository = stringField(value, "repository");
  const agent = stringField(value, "agent") ?? stringField(value, "model");
  const worktreeDir = stringField(value, "worktreeDir");
  const branchName = stringField(value, "branchName");
  const workspaceName = stringField(value, "workspaceName");
  const { state, resumeCount } = value;
  const createdAt = stringField(value, "createdAt");
  const updatedAt = stringField(value, "updatedAt");
  if (
    task === undefined ||
    repository === undefined ||
    agent === undefined ||
    worktreeDir === undefined ||
    branchName === undefined ||
    workspaceName === undefined ||
    !isRunLifecycleState(state) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    !isValidResumeCount(resumeCount)
  ) {
    return undefined;
  }
  return {
    task,
    repository,
    agent,
    worktreeDir,
    branchName,
    workspaceName,
    state,
    createdAt,
    updatedAt,
    resumeCount,
  };
}

type OptionalRunStateFields = Pick<
  RunState,
  | "reason"
  | "detail"
  | "title"
  | "url"
  | "completionTaskId"
  | "adoptedBranch"
  | "baseBranch"
  | "parentTask"
  | "needsRebase"
>;

function parseOptionalFields(value: Record<string, unknown>): OptionalRunStateFields {
  const reason = stringField(value, "reason");
  const detail = stringField(value, "detail");
  const title = stringField(value, "title");
  const url = stringField(value, "url");
  const completionTaskId = stringField(value, "completionTaskId");
  const adoptedBranch = value["adoptedBranch"] === true ? true : undefined;
  const baseBranch = stringField(value, "baseBranch");
  const parentTask = stringField(value, "parentTask");
  const needsRebase = value["needsRebase"] === true ? true : undefined;
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    ...(completionTaskId === undefined ? {} : { completionTaskId }),
    ...(adoptedBranch === undefined ? {} : { adoptedBranch }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(parentTask === undefined ? {} : { parentTask }),
    ...(needsRebase === undefined ? {} : { needsRebase }),
  };
}

function parseRunState(value: unknown): RunState | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const required = parseRequiredFields(value);
  if (required === undefined) {
    return undefined;
  }
  return { ...required, ...parseOptionalFields(value) };
}

function writeState(config: ResolvedConfig, state: RunState): void {
  writeJsonAtomic(runStatePath(config, state.task), state);
}

export function readRunState(config: ResolvedConfig, task: string): RunState | undefined {
  let raw: string;
  try {
    raw = readFileSync(runStatePath(config, task), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseRunState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

type ClearableOptionalField = "baseBranch" | "parentTask" | "needsRebase";

// Carries a clearable field's draft-or-prior value forward, unless the draft
// explicitly asked to drop it via `clearFields` (the failed-to-launch path
// clearing a leaked `baseBranch`/`parentTask`/`needsRebase`).
function carriedOrCleared<T>(
  field: ClearableOptionalField,
  cleared: ReadonlySet<string>,
  draftValue: T | undefined,
  priorValue: T | undefined,
): T | undefined {
  return cleared.has(field) ? undefined : (draftValue ?? priorValue);
}

// Resume/interrupt callers don't know these cached/stacking fields, so they
// omit them. Fall back to the on-disk value so they survive transitions.
function carryOptionalFields(
  draft: RunStateDraft,
  existing: RunState | undefined,
): OptionalRunStateFields {
  const prior: OptionalRunStateFields = existing ?? {};
  const cleared = new Set(draft.clearFields ?? []);
  const title = draft.title ?? prior.title;
  const url = draft.url ?? prior.url;
  const completionTaskId = draft.completionTaskId ?? prior.completionTaskId;
  const adoptedBranch = draft.adoptedBranch ?? prior.adoptedBranch;
  const baseBranch = carriedOrCleared("baseBranch", cleared, draft.baseBranch, prior.baseBranch);
  const parentTask = carriedOrCleared("parentTask", cleared, draft.parentTask, prior.parentTask);
  const needsRebase = carriedOrCleared(
    "needsRebase",
    cleared,
    draft.needsRebase,
    prior.needsRebase,
  );
  return {
    ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    ...(draft.detail === undefined ? {} : { detail: draft.detail }),
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    ...(completionTaskId === undefined ? {} : { completionTaskId }),
    ...(adoptedBranch === undefined ? {} : { adoptedBranch }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(parentTask === undefined ? {} : { parentTask }),
    ...(needsRebase === undefined ? {} : { needsRebase }),
  };
}

export function recordRunState(input: RecordRunStateInput): RunState {
  const existing = readRunState(input.config, input.state.task);
  const timestamp = nowIso();
  const state: RunState = {
    task: taskKey(input.state.task),
    repository: input.state.repository,
    agent: input.state.agent,
    worktreeDir: input.state.worktreeDir,
    branchName: input.state.branchName,
    workspaceName: input.state.workspaceName,
    state: input.state.state,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    resumeCount: input.state.resumeCount ?? existing?.resumeCount ?? 0,
    ...carryOptionalFields(input.state, existing),
  };
  writeState(input.config, state);
  return state;
}

export function updateRunState(input: UpdateRunStateInput): RunState | undefined {
  const existing = readRunState(input.config, input.task);
  if (existing === undefined) {
    return undefined;
  }
  const state: RunState = {
    ...existing,
    ...input.patch,
    task: existing.task,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  writeState(input.config, state);
  return state;
}

export function removeRunState(config: ResolvedConfig, task: string): void {
  rmSync(runStatePath(config, task), { force: true });
}

/**
 * Every run state on disk, e.g. for callers that need to find a task by a
 * field other than its own id (parent-teardown protection scans for a
 * `parentTask` match). A record that fails to parse is skipped rather than
 * aborting the scan, matching `readRunState`'s own tolerance for a malformed
 * or partially-written file.
 */
export function listRunStates(config: ResolvedConfig): RunState[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(runStateDirectory(config));
  } catch {
    return [];
  }
  const states: RunState[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) {
      continue;
    }
    const task = fileName.slice(0, -".json".length);
    const state = readRunState(config, task);
    if (state !== undefined) {
      states.push(state);
    }
  }
  return states;
}

/**
 * Clears `baseBranch` once a stacked child has rebased onto the default
 * branch, retaining `parentTask`. Also clears `needsRebase` — a prior tick
 * may have set it (dirty worktree or a rebase conflict) before this rebase
 * succeeded, and nothing else unsets it. `updateRunState`'s patch can only
 * merge fields in, never omit one, so this reads-modifies-writes the full
 * record instead; `delete` (not `= undefined`) is required under
 * `exactOptionalPropertyTypes`.
 */
export function clearBaseBranch(config: ResolvedConfig, task: string): RunState | undefined {
  const existing = readRunState(config, task);
  if (existing === undefined) {
    return undefined;
  }
  const next: RunState = { ...existing, updatedAt: nowIso() };
  delete next.baseBranch;
  delete next.needsRebase;
  writeState(config, next);
  return next;
}
