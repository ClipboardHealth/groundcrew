/**
 * The presenter contract seam (design doc §8, contracts §8). A presenter is
 * presentation-only: it decides WHERE an already-composed, already-sandbox-
 * wrapped agent command runs and HOW a human reaches it. Born serializable —
 * JSON in/out, nothing in-process — which by construction outlaws v1's cmux
 * `set-progress` hook leak.
 *
 * Nesting is presenter → sandbox → agent: `open` receives the fully composed
 * command and never knows about sandboxing. `probe().available === false` is
 * "we could not ask" and must never be read as "no sessions".
 */

/** The `open` spec (contracts §8). `command` arrives fully composed. */
export interface PresenterOpenSpec {
  /** Presenter session name (contracts §1: `crew-<taskSlug>`). */
  name: string;
  /** Optional human-facing title; adapters that have no title concept ignore it. */
  displayName?: string;
  /** Working directory the command runs in (the workspace root). */
  cwd: string;
  /** The fully composed command line (sandbox wrap included). */
  command: string;
  /**
   * Overlay environment for the session: profile env plus the injected
   * `GROUNDCREW_WORKSPACE`/`GROUNDCREW_TASK_ID`. The orchestrator's own
   * environment (PATH, …) is inherited by the presenter process; this map is
   * layered on top (contracts §9).
   */
  environment?: Record<string, string>;
  /** Optional initial status text for presenters that can paint one. */
  status?: string;
}

/** One presenter surface as reported by `probe`. */
export interface PresenterSession {
  name: string;
  /** False when the surface exists but its command has exited (a dead surface). */
  alive: boolean;
}

/**
 * The result of `probe`. `available` distinguishes "asked, here is the list"
 * from "could not ask" — the latter is never "no sessions" (contracts §8,
 * CRASH-04).
 */
export interface PresenterProbe {
  available: boolean;
  sessions: PresenterSession[];
}

/** Status paint payload for presenters that implement `setStatus`. */
export interface PresenterStatus {
  text: string;
  color?: string;
  icon?: string;
}

/**
 * The presenter contract, implemented in-core by the tmux, cmux, and zellij
 * adapters. `setStatus` is optional — capability by omission (cmux implements;
 * tmux and zellij omit).
 */
export interface Presenter {
  open: (spec: PresenterOpenSpec) => Promise<void>;
  probe: () => Promise<PresenterProbe>;
  close: (name: string) => Promise<void>;
  accessHint: (name: string) => Promise<string | undefined>;
  setStatus?: (name: string, status: PresenterStatus) => Promise<void>;
}
