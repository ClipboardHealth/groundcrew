/**
 * zellij presenter (session-per-task) — deliberately minimal and honest, and the
 * least-capable of the three in-core presenters. It names a session
 * `crew-<taskSlug>` (contracts §1), creates it detached (`attach
 * --create-background`), runs the composed command in a pane targeted at it,
 * probes `list-sessions`, and kills the session on close. zellij cannot paint
 * status pills, so `setStatus` is omitted (capability by omission).
 *
 * Validated LIVE against zellij 0.44 on macOS: a bare `zellij --session` is an
 * interactive attach (cannot work headless), and macOS's long $TMPDIR overflows
 * the unix-socket path limit — hence the pinned ZELLIJ_SOCKET_DIR below.
 *
 * `probe` distinguishes an unreachable/absent zellij (`available:false`) from a
 * reachable zellij with no sessions (the "no active sessions" signature →
 * `available:true, sessions:[]`) so an unavailable presenter is never read as an
 * empty one (CRASH-04). `list-sessions --short` prints bare session names, one
 * per line, so parsing keeps the leading token and filters to managed names.
 */

import { type ExecFn, type ExecResult, runProcess } from "./exec.js";
import { isManagedSessionName } from "./identity.js";
import type { Presenter, PresenterOpenSpec, PresenterProbe } from "./presenter.js";

const NO_SESSIONS_SIGNATURES = ["no active zellij sessions", "no sessions found"] as const;
const ALREADY_GONE_SIGNATURES = [
  "no session named",
  "not found",
  "does not exist",
  "no active zellij sessions",
] as const;

export interface CreateZellijPresenterInput {
  /** Injected process runner; defaults to the real one. */
  exec?: ExecFn;
}

export function createZellijPresenter(input: CreateZellijPresenterInput = {}): Presenter {
  const exec = input.exec ?? runProcess;
  // macOS's long per-user $TMPDIR plus a task-derived session name overflows
  // the 103-byte unix-socket path limit (found live: zellij refuses to start).
  // Every invocation pins a short socket dir so open/probe/close agree; an
  // ambient ZELLIJ_SOCKET_DIR wins so users keep their own arrangement.
  // oxlint-disable-next-line node/no-process-env -- presenter-internal env, like the tmux socket handling
  const socketDirectory = process.env["ZELLIJ_SOCKET_DIR"] ?? zellijSocketDirectory();

  function withSocket(env?: Record<string, string>): Record<string, string> {
    return { ...env, ZELLIJ_SOCKET_DIR: socketDirectory };
  }

  return {
    async open(spec: PresenterOpenSpec): Promise<void> {
      // Two steps, validated live against zellij 0.44: a bare `zellij
      // --session <name>` is an interactive attach and cannot work headless.
      // The detached session is created first (it inherits the env given
      // here), then the command runs in a pane targeted at that session.
      const created = await exec({
        command: "zellij",
        args: ["attach", "--create-background", spec.name],
        cwd: spec.cwd,
        env: withSocket(spec.environment),
      });
      if (created.spawnFailed || created.exitCode !== 0) {
        throw new Error(`zellij session launch failed for "${spec.name}": ${describe(created)}`);
      }

      const ran = await exec({
        command: "zellij",
        args: ["--session", spec.name, "run", "--cwd", spec.cwd, "--", "sh", "-c", spec.command],
        cwd: spec.cwd,
        env: withSocket(spec.environment),
      });
      if (ran.spawnFailed || ran.exitCode !== 0) {
        throw new Error(`zellij run failed for "${spec.name}": ${describe(ran)}`);
      }
    },

    async probe(): Promise<PresenterProbe> {
      const result = await exec({
        command: "zellij",
        args: ["list-sessions", "--short"],
        env: withSocket(),
      });
      if (result.exitCode === 0) {
        return { available: true, sessions: parseSessions(result.stdout) };
      }
      const haystack = `${result.stdout}\n${result.stderr}`;
      if (!result.spawnFailed && matchesAny(haystack, NO_SESSIONS_SIGNATURES)) {
        // Reachable zellij, no sessions: a definitive empty, not "unknown".
        return { available: true, sessions: [] };
      }
      return { available: false, sessions: [] };
    },

    async close(name: string): Promise<void> {
      const result = await exec({
        command: "zellij",
        args: ["kill-session", name],
        env: withSocket(),
      });
      if (result.exitCode === 0) {
        return;
      }
      const haystack = `${result.stdout}\n${result.stderr}`;
      if (!result.spawnFailed && matchesAny(haystack, ALREADY_GONE_SIGNATURES)) {
        // Idempotent: the session is already gone.
        return;
      }
      throw new Error(`zellij kill-session failed for "${name}": ${describe(result)}`);
    },

    async accessHint(name: string): Promise<string | undefined> {
      // The socket dir must travel with the hint, or a plain shell won't find
      // the session.
      return `ZELLIJ_SOCKET_DIR=${socketDirectory} zellij attach ${name}`;
    },
  };
}

function parseSessions(output: string): PresenterProbe["sessions"] {
  const sessions: PresenterProbe["sessions"] = [];
  for (const line of output.split("\n")) {
    const name = line.trim().split(/\s+/)[0] ?? "";
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

function describe(result: ExecResult): string {
  const detail = result.stderr.trim();
  if (detail.length > 0) {
    return detail;
  }
  return result.spawnFailed ? "zellij is not runnable" : `exit ${result.exitCode}`;
}

function zellijSocketDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/zellij-groundcrew-${String(uid)}`;
}
