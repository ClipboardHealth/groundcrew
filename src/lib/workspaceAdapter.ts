/**
 * Shared contract for Workspace backends. A Workspace is the host-side
 * terminal session that runs an agent for one task; `Workspace.name` is
 * the task id callers key on. The cmux and tmux adapters implement this
 * interface in their own files (`cmuxAdapter.ts`, `tmuxAdapter.ts`);
 * `workspaces.ts` resolves and fronts them. This is internal cleanup, not a
 * plugin contract — nothing here is a published extension point.
 */

import { runCommandAsync } from "./commandRunner.ts";

export type WorkspaceKind = "cmux" | "tmux" | "zellij";

export interface Workspace {
  /** Task id; the join key callers use. */
  name: string;
  /** Omitted means live, for backends that do not expose an exited state. */
  state?: "exited";
}

export interface WorkspaceStatus {
  text: string;
  color?: string;
  icon?: string;
}

export interface WorkspaceAccessHint {
  kind: "attachCommand";
  command: string;
}

export interface OpenSpec {
  /** Task id; becomes the workspace's name. */
  name: string;
  /** Working directory the workspace runs in. */
  cwd: string;
  /** Shell string the workspace executes (host setup + agent exec). */
  command: string;
  /** Optional status painting. Adapters that can't paint silently drop it. */
  status?: WorkspaceStatus;
}

/**
 * `unavailable` is "we don't know" — never treat it as "empty," or callers
 * would close every live workspace by deduction.
 */
export type WorkspaceProbe =
  | { kind: "ok"; names: Set<string>; exitedNames?: Set<string> }
  | { kind: "unavailable"; error?: unknown };

export type WorkspaceInterruptResult =
  | { kind: "interrupted" }
  | { kind: "missing" }
  | { kind: "unavailable"; error?: unknown };

export type WorkspaceCloseResult =
  | { kind: "closed" }
  | { kind: "missing" }
  | { kind: "unavailable"; error?: unknown };

export interface Adapter {
  open: (spec: OpenSpec, signal?: AbortSignal) => Promise<void>;
  /**
   * Known workspaces. Returns:
   * - `Workspace[]` when the adapter probe succeeded (may be empty).
   * - `undefined` when the adapter binary failed in a way that doesn't
   *   distinguish "no live workspaces" from "couldn't ask".
   */
  list: (signal?: AbortSignal) => Promise<Workspace[] | undefined>;
  /** Closes the workspace or confirms it is not present. */
  close: (name: string, signal?: AbortSignal) => Promise<WorkspaceCloseResult>;
  /**
   * User-facing way to reach the workspace, or `undefined` when the backend
   * has no concise external hint.
   */
  accessHint: (name: string) => WorkspaceAccessHint | undefined;
}

export async function runWorkspaceCommand(
  command: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return signal === undefined
    ? await runCommandAsync(command, arguments_)
    : await runCommandAsync(command, arguments_, { signal });
}

export function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
