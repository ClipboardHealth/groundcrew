/**
 * Dispatch's narrow input model (design doc §9.3, §9.4). Dispatch is consumed by
 * Shell alone; Shell maps `crew.config.jsonc` and the opened source handles onto
 * these interfaces. Every collaborator arrives as a value or a typed dependency —
 * Dispatch imports Acquisition/Workspace/Session/Run through their `index.ts`
 * surfaces only, never reaching into Sandbox (the launch policy type is borrowed
 * transitively from Session's `LaunchSessionInput`).
 */

import type { SourceHandle, Task } from "../acquisition/index.js";
import type { Logger } from "../logging/index.js";
import type {
  AgentProfileConfig,
  AgentSandboxConfig,
  LaunchSessionInput,
  Presenter,
} from "../session/index.js";
import type { WorkspaceConfig } from "../workspace/index.js";

/** The agent sandbox policy, borrowed from Session so Dispatch need not import Sandbox. */
export type LaunchPolicy = NonNullable<LaunchSessionInput["policy"]>;
/** The sandbox wrap seam, borrowed from Session (defaults to the real wrap inside Session). */
export type LaunchWrapCommand = NonNullable<LaunchSessionInput["wrapCommand"]>;

/** Skip verdict reasons persisted to `dispatch.json` (contracts §3.3). */
export const SKIP_REASONS = [
  "repo-not-on-disk",
  "slots-full",
  "claim-rejected",
  "ineligible",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** One persisted per-task verdict (contracts §3.3). */
export interface DispatchVerdict {
  skipReason: SkipReason;
  detail?: string;
  ts: string;
}

/** The `dispatch.json` document (contracts §3.3). */
export interface DispatchState {
  version: 1;
  verdicts: Record<string, DispatchVerdict>;
}

/** Agent routing config subset (`agents.default` + `agents.profiles`, contracts §5). */
export interface AgentRouting {
  /** `agents.default`; absent ⇒ no config-level routing fallback. */
  default?: string;
  /** `agents.profiles` keyed by profile name. */
  profiles: Record<string, AgentProfileConfig>;
}

/** One opened source plus its per-source routing (`sources[].agent`, contracts §5). */
export interface DispatchSource {
  handle: SourceHandle;
  /** `sources[].agent`; absent ⇒ falls back to `agents.default`. */
  defaultAgent?: string;
}

/**
 * Everything Dispatch needs for a poll/dispatch cycle. Shell builds this once and
 * reuses it across ticks; the sole per-tick knob is {@link TickInput.reconcile}.
 */
export interface DispatchDeps {
  /** State root (`runs/`, `dispatch.json`, `source-scratch/`) — contracts §2. */
  stateRoot: string;
  /** Workspace path/naming config (contracts §5); the repo universe lives under it. */
  workspaceConfig: WorkspaceConfig;
  /** The presenter that hosts and probes sessions (Session's contract seam). */
  presenter: Presenter;
  /** Live sources, in config order — dispatch ordering is stable within a source. */
  sources: readonly DispatchSource[];
  /** Agent routing (`task.agent` → `sources[].agent` → `agents.default`). */
  agents: AgentRouting;
  /** Live-run slot cap (`orchestrator.maximumInProgress`). */
  maximumInProgress: number;
  /** Ambient env whose `PATH` gates the launch (contracts §9); the orchestrator's own. */
  environment: Record<string, string>;
  /** `workspace.environment` layered into the session env beneath the profile env (contracts §5/§9). */
  sessionEnvironment?: Record<string, string>;
  /**
   * The prompt template (`prompts.initial`, or the contents of `prompts.promptFile`)
   * rendered per task with `{{id}}`/`{{title}}`/`{{description}}`/`{{repos}}`
   * (contracts §5/§9). Omitted ⇒ dispatch renders the default template so the
   * launched agent always receives its task context.
   */
  promptTemplate?: string;
  /**
   * The launching crew's `bin` directory, prepended to each session's PATH so
   * in-session `crew` resolves to this installation (contracts §9). Omitted ⇒
   * the session inherits ambient PATH unchanged.
   */
  crewBinDir?: string;
  /**
   * Config-derived agent sandbox slice (read-only dirs + optional egress);
   * omitted ⇒ the launch is not sandbox-wrapped. Dispatch composes the full
   * per-task policy from this via Session's `composeAgentPolicy`.
   */
  agentSandbox?: AgentSandboxConfig;
  /** Agent kinds in play (profile names) — scopes the per-agent home grants. */
  agentKinds?: readonly string[];
  /** Injected sandbox wrap; omitted ⇒ Session's real `wrapCommand`. */
  wrapCommand?: LaunchWrapCommand;
  logger?: Logger;
  now?: () => Date;
}

/** One tick of the picker. */
export interface TickInput extends DispatchDeps {
  /** Run reconcile before polling (startup + every Nth cycle). Default `true`. */
  reconcile?: boolean;
}

/** A single-task dispatch (`crew start <task>`). */
export interface StartTaskInput extends DispatchDeps {
  /** Canonical task id (`<source>:<localId>`). */
  taskId: string;
  /** `--force`: bypass blocked/slots/eligibility, never the repo gate. */
  force?: boolean;
  /** `--agent`: override the resolved agent profile. */
  agent?: string;
}

/** Reconcile inputs (a subset of the dispatch deps). */
export interface ReconcileInput {
  stateRoot: string;
  workspaceConfig: WorkspaceConfig;
  presenter: Presenter;
  logger?: Logger;
  now?: () => Date;
}

/** What a tick did, for Shell's rendering and logs. */
export interface TickReport {
  /** Canonical ids launched this tick. */
  dispatched: string[];
  /** Canonical ids reaped by the terminal sweep. */
  reaped: string[];
  /** Verdicts persisted this tick, keyed by canonical id. */
  skipped: Record<string, DispatchVerdict>;
  reconcile?: ReconcileReport;
}

/**
 * A dry-run dispatch plan (`crew start --dry-run`): the same poll + eligibility
 * pass a tick would run, with NOTHING claimed, provisioned, or launched. Claim
 * contention is unknowable without a side effect, so a task that clears every
 * local gate is listed as would-dispatch optimistically.
 */
export interface DispatchPlan {
  /** Canonical ids that would be dispatched this tick, in dispatch order. */
  wouldDispatch: string[];
  /** Per-task skip verdicts, keyed by canonical id (same reasons a tick persists). */
  skipped: Record<string, DispatchVerdict>;
}

/** The outcome of a single-task dispatch. */
export interface StartTaskReport {
  taskId: string;
  dispatched: boolean;
  runId?: string;
  /** Present when the task was not dispatched (blocked, unrouted, rejected, slots). */
  verdict?: DispatchVerdict;
}

/** What reconcile GC'd and what it found but refused to touch. */
export interface ReconcileReport {
  /** False when the presenter probe was unavailable — reconcile did nothing destructive. */
  available: boolean;
  gc: {
    worktrees: string[];
    sessions: string[];
    runRecords: string[];
    sandboxes: string[];
  };
  /** Live-state runs whose session died — reported loudly, never auto-GC'd. */
  orphanedRunning: string[];
  /** Live managed sessions with no run record behind them — reported, never closed. */
  straySessions: string[];
}

/** A task paired with the source it came from, threaded through the pipeline. */
export interface SourcedTask {
  task: Task;
  source: DispatchSource;
}
