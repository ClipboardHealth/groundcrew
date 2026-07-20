/**
 * zellij presenter (session-per-task) — deliberately minimal and honest, and the
 * least-capable of the three in-core presenters. zellij has no detached-launch
 * verb as clean as tmux's `new-session -d`, so this adapter does the least it can
 * do honestly: it names a session `crew-<taskSlug>` (contracts §1) and runs the
 * composed command in it (command on stdin, cwd/env threaded through the process
 * seam), probes `list-sessions`, and kills the session on close. zellij cannot
 * paint status pills, so `setStatus` is omitted (capability by omission).
 *
 * zellij is unavailable on the dev/CI host, so — like the cmux and tmux
 * failure-signature branches — this adapter is driven entirely through the
 * injected `ExecFn` in unit tests (composed-argv assertions), never a live
 * binary. Its live launch path is intentionally unvalidated for v2.0; tmux and
 * cmux are the validated presenters.
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

  return {
    async open(spec: PresenterOpenSpec): Promise<void> {
      const result = await exec({
        command: "zellij",
        args: ["--session", spec.name],
        cwd: spec.cwd,
        ...(spec.environment === undefined ? {} : { env: spec.environment }),
        stdin: spec.command,
      });
      if (result.spawnFailed || result.exitCode !== 0) {
        throw new Error(`zellij session launch failed for "${spec.name}": ${describe(result)}`);
      }
    },

    async probe(): Promise<PresenterProbe> {
      const result = await exec({ command: "zellij", args: ["list-sessions", "--short"] });
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
      const result = await exec({ command: "zellij", args: ["kill-session", name] });
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
      return `zellij attach ${name}`;
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
