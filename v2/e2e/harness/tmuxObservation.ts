/**
 * Read-only tmux observation on the scenario's isolated socket (catalog §1.2).
 *
 * The suite treats tmux as a real seam: sessions live on a per-scenario socket
 * (`tmux -L <scenario-id>`, contracts §7), so observation never sees the host's
 * tmux server. A session that exists is alive; a session that has exited is
 * simply absent. All calls go through the scenario's hermetic env, which sets
 * GROUNDCREW_TMUX_SOCKET, but the socket is passed explicitly here so these
 * helpers do not depend on the binding under test honoring it.
 */

import { run } from "./exec.js";
import { pollUntil } from "./poll.js";
import type { Scenario } from "./scenario.js";

/** True when a session named `name` currently exists (is alive) on the socket. */
export async function sessionExists(input: {
  readonly scenario: Scenario;
  readonly name: string;
}): Promise<boolean> {
  const result = await tmux({
    scenario: input.scenario,
    args: ["has-session", "-t", input.name],
  });
  return result.exitCode === 0;
}

/** Session names currently on the socket. Empty when the server is not running. */
export async function listSessionNames(input: {
  readonly scenario: Scenario;
}): Promise<string[]> {
  const result = await tmux({
    scenario: input.scenario,
    args: ["list-sessions", "-F", "#{session_name}"],
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** Blocks until a session named `name` exists, or fails with a timeout. */
export async function waitForSession(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly timeoutMilliseconds?: number;
}): Promise<void> {
  await pollUntil({
    description: `tmux session '${input.name}' to exist`,
    timeoutMilliseconds: input.timeoutMilliseconds,
    condition: async () => await sessionExists({ scenario: input.scenario, name: input.name }),
  });
}

/** Blocks until a session named `name` no longer exists (has exited/closed). */
export async function waitForSessionGone(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly timeoutMilliseconds?: number;
}): Promise<void> {
  await pollUntil({
    description: `tmux session '${input.name}' to be gone`,
    timeoutMilliseconds: input.timeoutMilliseconds,
    condition: async () =>
      !(await sessionExists({ scenario: input.scenario, name: input.name })),
  });
}

async function tmux(input: {
  readonly scenario: Scenario;
  readonly args: readonly string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await run({
    command: "tmux",
    args: ["-L", input.scenario.tmuxSocket, ...input.args],
    env: input.scenario.env,
    timeoutMilliseconds: 15_000,
  });
}
