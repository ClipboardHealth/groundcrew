import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ResolvedConfig } from "./config.ts";

export type RunLifecycleState = "running" | "interrupted" | "resumed" | "failed-to-launch";

export interface RunState {
  task: string;
  repository: string;
  model: string;
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
}

export interface RunStateDraft {
  task: string;
  repository: string;
  model: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  state: RunLifecycleState;
  reason?: string;
  detail?: string;
  resumeCount?: number;
  title?: string;
  url?: string;
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

const TASK_RE = /^[a-z][\da-z]*-\d+$/;
const RUN_STATE_DIRECTORY_NAME = "runs";

function taskKey(task: string): string {
  const normalized = task.toLowerCase();
  if (!TASK_RE.test(normalized)) {
    throw new Error(`Invalid task "${task}": must be a plain task id`);
  }
  return normalized;
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

function stringField(value: Record<string, unknown>, key: keyof RunState): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRunLifecycleState(value: unknown): value is RunLifecycleState {
  return (
    value === "running" ||
    value === "interrupted" ||
    value === "resumed" ||
    value === "failed-to-launch"
  );
}

function parseRunState(value: unknown): RunState | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const task = stringField(value, "task");
  const repository = stringField(value, "repository");
  const model = stringField(value, "model");
  const worktreeDir = stringField(value, "worktreeDir");
  const branchName = stringField(value, "branchName");
  const workspaceName = stringField(value, "workspaceName");
  const { state, resumeCount } = value;
  const createdAt = stringField(value, "createdAt");
  const updatedAt = stringField(value, "updatedAt");
  const reason = stringField(value, "reason");
  const detail = stringField(value, "detail");
  const title = stringField(value, "title");
  const url = stringField(value, "url");
  if (
    task === undefined ||
    repository === undefined ||
    model === undefined ||
    worktreeDir === undefined ||
    branchName === undefined ||
    workspaceName === undefined ||
    !isRunLifecycleState(state) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    typeof resumeCount !== "number" ||
    !Number.isInteger(resumeCount) ||
    resumeCount < 0
  ) {
    return undefined;
  }
  return {
    task,
    repository,
    model,
    worktreeDir,
    branchName,
    workspaceName,
    state,
    createdAt,
    updatedAt,
    resumeCount,
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
  };
}

function writeState(config: ResolvedConfig, state: RunState): void {
  const statePath = runStatePath(config, state.task);
  mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, statePath);
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

export function recordRunState(input: RecordRunStateInput): RunState {
  const existing = readRunState(input.config, input.state.task);
  const timestamp = nowIso();
  // Resume/interrupt callers don't know the title or url, so they omit
  // them. Fall back to the on-disk value so cached display fields survive
  // transitions.
  const title = input.state.title ?? existing?.title;
  const url = input.state.url ?? existing?.url;
  const state: RunState = {
    task: taskKey(input.state.task),
    repository: input.state.repository,
    model: input.state.model,
    worktreeDir: input.state.worktreeDir,
    branchName: input.state.branchName,
    workspaceName: input.state.workspaceName,
    state: input.state.state,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    resumeCount: input.state.resumeCount ?? existing?.resumeCount ?? 0,
    ...(input.state.reason === undefined ? {} : { reason: input.state.reason }),
    ...(input.state.detail === undefined ? {} : { detail: input.state.detail }),
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
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
