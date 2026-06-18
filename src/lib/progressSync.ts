/**
 * Bridges run-state lifecycle transitions to the cmux sidebar: when a task
 * launches or resumes, paint its workspace row with the current lifecycle
 * status so a sidebar can show live agent activity. Best-effort and cosmetic —
 * a failure here must never break a launch, so it is swallowed and logged.
 *
 * Only `running` and `resumed` reach a live workspace: `interrupt` closes the
 * cmux workspace before recording state, and `provisioning`/`failed-to-launch`
 * precede a workspace existing. The phase value is a coarse carrier for cmux
 * `set-progress`, not context-window usage; sidebars render the label.
 */

import type { ResolvedConfig } from "./config.ts";
import type { RunLifecycleState } from "./runState.ts";
import { errorMessage, logEvent } from "./util.ts";
import { workspaces } from "./workspaces.ts";

const PROGRESS_SYNC_FLOW = "cmux-progress-sync";

const LIFECYCLE_PHASE_VALUE: Record<RunLifecycleState, number> = {
  provisioning: 0.1,
  running: 0.5,
  resumed: 0.5,
  interrupted: 0.25,
  "failed-to-launch": 1,
};

interface SyncWorkspaceProgressInput {
  config: ResolvedConfig;
  run: {
    task: string;
    workspaceName: string;
    agent: string;
    state: RunLifecycleState;
  };
  signal?: AbortSignal;
}

export async function syncWorkspaceProgress(input: SyncWorkspaceProgressInput): Promise<void> {
  const { config, run, signal } = input;
  try {
    await workspaces.reportProgress(
      config,
      run.workspaceName,
      { value: LIFECYCLE_PHASE_VALUE[run.state], label: `${run.state} · ${run.agent}` },
      signal,
    );
    logEvent(PROGRESS_SYNC_FLOW, {
      outcome: "synced",
      task: run.task,
      workspace: run.workspaceName,
      state: run.state,
    });
  } catch (error) {
    logEvent(PROGRESS_SYNC_FLOW, {
      outcome: "error",
      task: run.task,
      workspace: run.workspaceName,
      state: run.state,
      error: errorMessage(error),
    });
  }
}
