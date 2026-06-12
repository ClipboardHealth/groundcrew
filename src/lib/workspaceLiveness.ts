import type { ResolvedConfig } from "./config.ts";
import { errorMessage } from "./util.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Fail if a workspace for `task` is already live (or its liveness can't be
 * verified) before reopening its worktree. Shared by `crew resume` and `crew
 * open`; `verb` names the action in the error so the guidance reads naturally.
 */
export async function failIfWorkspaceAlreadyLive(
  config: ResolvedConfig,
  task: string,
  verb: "resuming" | "opening",
): Promise<void> {
  const probe = await workspaces.probe(config);
  if (probe.kind === "unavailable") {
    const detail = probe.error === undefined ? "" : `: ${errorMessage(probe.error)}`;
    throw new Error(
      `Could not verify whether workspace for ${task} is already live${detail}. Retry or inspect the workspace backend manually before ${verb}.`,
    );
  }
  if (probe.names.has(task)) {
    throw new Error(`Workspace for ${task} is already live; attach to it instead of ${verb}.`);
  }
}
