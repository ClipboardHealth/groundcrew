/**
 * cmux presenter (session-per-task). cmux is the macOS TUI: each task is its own
 * cmux workspace named `crew-<taskSlug>` (contracts §1), created with the fully
 * composed agent command. cmux can paint a per-workspace status pill, so this is
 * the one adapter that implements `setStatus` — capability by presence
 * (contracts §8, design doc §8).
 *
 * Identity keys on a description marker (`groundcrew:<name>`) stamped at
 * creation, never the title: a user renaming a panel must not make groundcrew
 * lose the workspace (ported from the v1 cmux backend). `probe`/`close`/
 * `setStatus` resolve the workspace by that marker — falling back to the title
 * for unmarked workspaces — and act on cmux's stable `ref`. A `probe` that
 * cannot reach cmux reports `available:false`, never conflated with an honest
 * empty list (CRASH-04).
 *
 * cmux keeps a workspace alive after its command exits (the pane persists), so
 * unlike tmux a present workspace cannot be proven dead from the outside; probe
 * reports every present managed workspace as `alive:true`.
 */

import { z } from "zod";

import { type ExecFn, type ExecResult, runProcess } from "./exec.js";
import { isManagedSessionName } from "./identity.js";
import type { Presenter, PresenterOpenSpec, PresenterProbe, PresenterStatus } from "./presenter.js";

/** Stable per-workspace task marker stamped into cmux's description at creation. */
const DESCRIPTION_MARKER_PREFIX = "groundcrew:";

/** The `set-status` key groundcrew owns; other tools manage their own keys. */
const STATUS_KEY = "agent";

export interface CreateCmuxPresenterInput {
  /** Injected process runner; defaults to the real one. */
  exec?: ExecFn;
}

export function createCmuxPresenter(input: CreateCmuxPresenterInput = {}): Presenter {
  const exec = input.exec ?? runProcess;

  async function listWorkspaces(): Promise<CmuxWorkspace[] | undefined> {
    const result = await exec({ command: "cmux", args: ["--json", "list-workspaces"] });
    if (result.spawnFailed || result.exitCode !== 0) {
      return undefined;
    }
    return parseWorkspaces(result.stdout);
  }

  return {
    async open(spec: PresenterOpenSpec): Promise<void> {
      const result = await exec({
        command: "cmux",
        args: [
          "--json",
          "new-workspace",
          "--name",
          spec.displayName ?? spec.name,
          "--cwd",
          spec.cwd,
          "--command",
          spec.command,
          "--description",
          `${DESCRIPTION_MARKER_PREFIX}${spec.name}`,
          ...environmentFlags(spec.environment),
        ],
      });
      if (result.spawnFailed || result.exitCode !== 0) {
        throw new Error(`cmux new-workspace failed for "${spec.name}": ${describe(result)}`);
      }
      if (spec.status !== undefined) {
        // The pill is best-effort: a launch must not fail because cmux could not
        // paint status. It rides the new workspace's ref out of the open output.
        const ref = extractOpenRef(result.stdout);
        if (ref !== undefined) {
          await applyStatus(exec, ref, { text: spec.status }).catch(() => {
            /* best-effort */
          });
        }
      }
    },

    async probe(): Promise<PresenterProbe> {
      const workspaces = await listWorkspaces();
      if (workspaces === undefined) {
        return { available: false, sessions: [] };
      }
      const sessions = workspaces
        .map((workspace) => managedName(workspace))
        .filter((name) => isManagedSessionName(name))
        .map((name) => ({ name, alive: true }));
      return { available: true, sessions };
    },

    async close(name: string): Promise<void> {
      const workspaces = await listWorkspaces();
      if (workspaces === undefined) {
        throw new Error(`cmux close-workspace failed for "${name}": could not list workspaces`);
      }
      const matches = workspaces.filter((workspace) => managedName(workspace) === name);
      // No match is an idempotent no-op: the workspace is already gone.
      for (const match of matches) {
        // oxlint-disable-next-line no-await-in-loop -- closes mutate shared cmux state; run them one at a time
        const result = await exec({
          command: "cmux",
          args: ["close-workspace", "--workspace", match.ref],
        });
        if (result.spawnFailed || result.exitCode !== 0) {
          throw new Error(
            `cmux close-workspace failed for "${name}" (${match.ref}): ${describe(result)}`,
          );
        }
      }
    },

    async accessHint(name: string): Promise<string | undefined> {
      return `Open the cmux app and select the "${name}" workspace.`;
    },

    async setStatus(name: string, status: PresenterStatus): Promise<void> {
      const workspaces = await listWorkspaces();
      if (workspaces === undefined) {
        throw new Error(`cmux set-status failed for "${name}": could not list workspaces`);
      }
      const match = workspaces.find((workspace) => managedName(workspace) === name);
      if (match === undefined) {
        // Nothing to paint; the workspace is absent.
        return;
      }
      await applyStatus(exec, match.ref, status);
    },
  };
}

interface CmuxWorkspace {
  ref: string;
  title: string;
  description: string | null;
}

const listSchema = z.object({
  workspaces: z
    .array(
      z.object({
        ref: z.string().optional(),
        id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().nullish(),
      }),
    )
    .optional(),
});

function parseWorkspaces(stdout: string): CmuxWorkspace[] {
  const parsed = listSchema.safeParse(safeJson(stdout));
  if (!parsed.success) {
    return [];
  }
  const workspaces: CmuxWorkspace[] = [];
  for (const entry of parsed.data.workspaces ?? []) {
    const ref = entry.ref ?? entry.id;
    if (ref === undefined || ref.length === 0) {
      // cmux close-workspace needs a ref/id; a workspace we cannot address is skipped.
      continue;
    }
    workspaces.push({ ref, title: entry.title ?? "", description: entry.description ?? null });
  }
  return workspaces;
}

/**
 * The task marker if the description carries one, else the title. Mirrors the v1
 * fallback: legacy workspaces created without a marker are still addressable by
 * their title.
 */
function managedName(workspace: CmuxWorkspace): string {
  const { description } = workspace;
  if (description !== null && description.startsWith(DESCRIPTION_MARKER_PREFIX)) {
    const marked = description.slice(DESCRIPTION_MARKER_PREFIX.length);
    if (marked.length > 0) {
      return marked;
    }
  }
  return workspace.title;
}

const openRefSchema = z.object({
  workspace_id: z.string().optional(),
  id: z.string().optional(),
  workspace_ref: z.string().optional(),
  ref: z.string().optional(),
});

/** Recover the created workspace's ref from `new-workspace --json` output. */
function extractOpenRef(stdout: string): string | undefined {
  const parsed = openRefSchema.safeParse(safeJson(stdout));
  if (parsed.success) {
    const ref =
      parsed.data.workspace_id ?? parsed.data.id ?? parsed.data.workspace_ref ?? parsed.data.ref;
    if (ref !== undefined && ref.length > 0) {
      return ref;
    }
  }
  return /workspace:\d+/.exec(stdout)?.[0];
}

async function applyStatus(exec: ExecFn, ref: string, status: PresenterStatus): Promise<void> {
  const args = ["set-status", STATUS_KEY, status.text];
  if (status.icon !== undefined) {
    args.push("--icon", status.icon);
  }
  if (status.color !== undefined) {
    args.push("--color", status.color);
  }
  args.push("--workspace", ref);
  const result = await exec({ command: "cmux", args });
  if (result.spawnFailed || result.exitCode !== 0) {
    throw new Error(`cmux set-status failed for workspace ${ref}: ${describe(result)}`);
  }
}

function environmentFlags(environment: Record<string, string> | undefined): string[] {
  if (environment === undefined) {
    return [];
  }
  const flags: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    flags.push("--env", `${key}=${value}`);
  }
  return flags;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(result: ExecResult): string {
  const detail = result.stderr.trim();
  if (detail.length > 0) {
    return detail;
  }
  return result.spawnFailed ? "cmux is not runnable" : `exit ${result.exitCode}`;
}
