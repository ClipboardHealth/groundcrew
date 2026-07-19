/**
 * tmux presenter (session-per-task). Each task is its own detached tmux
 * session named `crew-<taskSlug>` (contracts §1); the agent command runs in it
 * at the workspace root. tmux cannot paint status pills, so `setStatus` is
 * omitted (capability by omission).
 *
 * Socket isolation is the load-bearing property for the e2e suite (contracts
 * §7): when `GROUNDCREW_TMUX_SOCKET` is set, EVERY tmux call uses `-L <socket>`,
 * so the suite never touches the host's default tmux server. The socket is read
 * once at construction and threaded through every invocation.
 *
 * "A session that has exited is simply absent" — the presenter leaves
 * `remain-on-exit` at its default (off), so an exited agent's session vanishes
 * on its own and `probe` never reports it. A `probe` that cannot reach tmux
 * reports `available:false`; a reachable-but-serverless tmux is an honest empty
 * (`available:true, sessions:[]`), never conflated with the former (CRASH-04).
 */

import { type ExecFn, runProcess } from "./exec.js";
import { isManagedSessionName } from "./identity.js";
import type { Presenter, PresenterOpenSpec, PresenterProbe } from "./presenter.js";

const NO_SERVER_SIGNATURES = ["no server running", "error connecting to"] as const;
const ALREADY_GONE_SIGNATURES = [
  "no server running",
  "can't find session",
  "session not found",
] as const;

export interface CreateTmuxPresenterInput {
  /** Injected process runner; defaults to the real one. */
  exec?: ExecFn;
  /**
   * tmux server socket. Defaults to `GROUNDCREW_TMUX_SOCKET`; when present,
   * every tmux call is prefixed with `-L <socket>`.
   */
  socket?: string;
}

export function createTmuxPresenter(input: CreateTmuxPresenterInput = {}): Presenter {
  const exec = input.exec ?? runProcess;
  const socket = input.socket ?? readSocketFromEnvironment();

  function tmuxArgs(rest: readonly string[]): string[] {
    return socket === undefined ? [...rest] : ["-L", socket, ...rest];
  }

  return {
    async open(spec: PresenterOpenSpec): Promise<void> {
      const result = await exec({
        command: "tmux",
        args: tmuxArgs([
          "new-session",
          "-d",
          "-s",
          spec.name,
          "-c",
          spec.cwd,
          ...environmentFlags(spec.environment),
          spec.command,
        ]),
      });
      if (result.spawnFailed || result.exitCode !== 0) {
        throw new Error(`tmux new-session failed for "${spec.name}": ${describe(result)}`);
      }
    },

    async probe(): Promise<PresenterProbe> {
      const result = await exec({
        command: "tmux",
        args: tmuxArgs(["list-sessions", "-F", "#{session_name}"]),
      });
      if (result.exitCode === 0) {
        return { available: true, sessions: parseSessions(result.stdout) };
      }
      if (!result.spawnFailed && matchesAny(result.stderr, NO_SERVER_SIGNATURES)) {
        // Reachable tmux, no server up yet: a definitive empty, not "unknown".
        return { available: true, sessions: [] };
      }
      return { available: false, sessions: [] };
    },

    async close(name: string): Promise<void> {
      const result = await exec({
        command: "tmux",
        args: tmuxArgs(["kill-session", "-t", name]),
      });
      if (result.exitCode === 0) {
        return;
      }
      if (!result.spawnFailed && matchesAny(result.stderr, ALREADY_GONE_SIGNATURES)) {
        // Idempotent: the session is already gone.
        return;
      }
      throw new Error(`tmux kill-session failed for "${name}": ${describe(result)}`);
    },

    accessHint(name: string): Promise<string | undefined> {
      const prefix = socket === undefined ? "" : `-L ${socket} `;
      return Promise.resolve(`tmux ${prefix}attach -t ${name}`);
    },
  };
}

// oxlint-disable-next-line node/no-process-env -- the tmux socket is a presenter-internal env seam (contracts §7)
function readSocketFromEnvironment(): string | undefined {
  const value = process.env["GROUNDCREW_TMUX_SOCKET"];
  return value === undefined || value.length === 0 ? undefined : value;
}

function environmentFlags(environment: Record<string, string> | undefined): string[] {
  if (environment === undefined) {
    return [];
  }
  const flags: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    flags.push("-e", `${key}=${value}`);
  }
  return flags;
}

function parseSessions(output: string): PresenterProbe["sessions"] {
  const sessions: PresenterProbe["sessions"] = [];
  for (const line of output.split("\n")) {
    const name = line.trim();
    if (name.length === 0 || !isManagedSessionName(name)) {
      continue;
    }
    sessions.push({ name, alive: true });
  }
  return sessions;
}

function matchesAny(text: string, signatures: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  return signatures.some((signature) => lowered.includes(signature));
}

function describe(result: { exitCode: number; stderr: string }): string {
  const detail = result.stderr.trim();
  return detail.length > 0 ? detail : `exit ${result.exitCode}`;
}
