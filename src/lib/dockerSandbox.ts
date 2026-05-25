import { runCommandAsync } from "./commandRunner.ts";
import type { SandboxDefinition } from "./config.ts";
import { applyGitDefaults } from "./sandboxGitDefaults.ts";

/**
 * Derive a deterministic sbx sandbox name from the sbx agent so every
 * groundcrew model that targets the same agent reuses one sandbox across
 * repositories and tickets. Lowercased and reduced to the sbx-safe
 * charset (`a-z0-9.+-`) so unusual agent names still round-trip cleanly.
 * Keep the `groundcrew-` prefix stable — doctor and teardown use it to
 * identify groundcrew-owned sandboxes.
 */
export function sandboxNameFor(arguments_: { agent: string }): string {
  const raw = `groundcrew-${arguments_.agent}`.toLowerCase();
  return raw
    .replaceAll(/[^a-z0-9.+-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/**
 * Probe `sbx ls` to see whether a sandbox with `sandboxName` already
 * exists. Used by `crew sandbox auth` to switch between create vs reuse
 * branches without surfacing the raw sbx error on first run.
 */
export async function sandboxExists(sandboxName: string, signal?: AbortSignal): Promise<boolean> {
  const out =
    signal === undefined
      ? await runCommandAsync("sbx", ["ls"])
      : await runCommandAsync("sbx", ["ls"], { signal });
  return out.split("\n").some((line) => line.trim().split(/\s+/)[0] === sandboxName);
}

interface EnsureSandboxArguments {
  sandboxName: string;
  sandbox: SandboxDefinition;
  /**
   * Host path bound into the sandbox at the same path. Pass the workspace
   * `projectDir` so all per-ticket worktrees (siblings of the bare repo
   * clone) are visible to `sbx exec -w <worktreeDir>` after creation.
   */
  mountPath: string;
  /**
   * When true, apply the standard git defaults inside the sandbox after
   * it exists (idempotent, runs whether the sandbox was just created or
   * already there). See `sandboxGitDefaults.ts` for what gets set.
   */
  gitDefaults: boolean;
  /**
   * Result of an earlier `sandboxExists` probe by the caller, used to
   * skip the initial `sbx ls` here. Leave undefined to let this function
   * probe on its own.
   */
  alreadyExists?: boolean;
}

/**
 * Idempotent guard: ensure a Docker Sandboxes container exists for the
 * given repository + model. Probes `sbx ls`; if `sandboxName` is missing,
 * calls `sbx create --name <name> [--template <t>] [--kit <k>]... <agent>
 * <mountPath>` to provision it. Once the container exists (newly created
 * or pre-existing), applies the standard git defaults when enabled.
 * First-time agent auth still happens inside the sandbox the first time
 * `sbx exec` runs the agent — `create` only provisions the container, it
 * does not attach.
 */
async function resolveExistence(
  arguments_: EnsureSandboxArguments,
  signal?: AbortSignal,
): Promise<boolean> {
  if (arguments_.alreadyExists === undefined) {
    return await sandboxExists(arguments_.sandboxName, signal);
  }
  return arguments_.alreadyExists;
}

export async function ensureSandbox(
  arguments_: EnsureSandboxArguments,
  signal?: AbortSignal,
): Promise<void> {
  const existed = await resolveExistence(arguments_, signal);
  if (!existed) {
    const createArguments: string[] = ["create", "--name", arguments_.sandboxName];
    if (arguments_.sandbox.template !== undefined) {
      createArguments.push("--template", arguments_.sandbox.template);
    }
    for (const kit of arguments_.sandbox.kits ?? []) {
      createArguments.push("--kit", kit);
    }
    createArguments.push(arguments_.sandbox.agent, arguments_.mountPath);
    const options = signal === undefined ? {} : { signal };
    try {
      await runCommandAsync("sbx", createArguments, options);
    } catch (error) {
      if (!(await sandboxExists(arguments_.sandboxName, signal))) {
        throw error;
      }
    }
  }
  if (arguments_.gitDefaults) {
    await applyGitDefaults({ sandboxName: arguments_.sandboxName }, signal);
  }
}
