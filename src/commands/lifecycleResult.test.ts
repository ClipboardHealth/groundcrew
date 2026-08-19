import { afterEach, describe, expect, it } from "vitest";

import { captureConsoleLog } from "../testHelpers/consoleCapture.ts";
import {
  lifecycleResultExitCode,
  renderLifecycleResult,
  type LifecycleResult,
} from "./lifecycleResult.ts";

function renderHuman(result: LifecycleResult): string {
  const consoleLog = captureConsoleLog();
  try {
    renderLifecycleResult({ result, json: false });
    return consoleLog.output();
  } finally {
    consoleLog.restore();
  }
}

describe(renderLifecycleResult, () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("writes exactly one JSON document for a successful result", () => {
    const consoleLog = captureConsoleLog();
    const result: LifecycleResult = {
      action: "start",
      task: {
        id: "team-1",
        canonicalId: "linear:team-1",
        url: "https://linear.app/example/issue/TEAM-1",
      },
      outcome: "started",
      state: "running",
      resources: {
        repository: "repo-a",
        branch: "dev-team-1",
        worktreeDir: "/work/repo-a-team-1",
        workspace: { name: "team-1" },
      },
      problems: [],
    };

    try {
      renderLifecycleResult({ result, json: true });

      expect(consoleLog.calls).toHaveLength(1);
      expect(JSON.parse(consoleLog.output())).toStrictEqual(result);
    } finally {
      consoleLog.restore();
    }
  });

  it.each<{ result: LifecycleResult; output: string }>([
    {
      result: {
        action: "start",
        task: { id: "team-1" },
        outcome: "started",
        state: "running",
        resources: {},
        problems: [],
      },
      output: '✓ "team-1" launched',
    },
    {
      result: {
        action: "start",
        task: { id: "team-1" },
        outcome: "started",
        state: "running",
        resources: {
          agent: "codex",
          worktreeDir: "/work/team-1",
          workspace: { name: "team-1", accessCommand: "cmux attach team-1" },
        },
        problems: [],
      },
      output: '✓ "team-1" launched (codex)  worktree /work/team-1\nAttach: cmux attach team-1',
    },
    {
      result: {
        action: "start",
        task: { id: "team-1" },
        outcome: "already-running",
        state: "running",
        resources: {},
        problems: [],
      },
      output: "Task team-1 is already running; no changes made.",
    },
    {
      result: {
        action: "start",
        task: { id: "team-1" },
        outcome: "dry-run",
        state: "absent",
        resources: { worktreePreparation: "skip" },
        problems: [],
      },
      output:
        "[dry-run] Would launch team-1 in the resolved repository (the resolved agent); prepareWorktree skipped",
    },
    {
      result: {
        action: "start",
        task: { id: "team-1" },
        outcome: "conflict",
        state: "unknown",
        resources: {},
        problems: [{ code: "workspace-conflict", message: "Workspace conflicts." }],
      },
      output: "Start conflict for team-1: Workspace conflicts.",
    },
    {
      result: {
        action: "stop",
        task: { id: "team-1" },
        outcome: "stopped",
        state: "interrupted",
        resources: {},
        problems: [],
      },
      output: "Interrupted team-1\nNext: crew status team-1",
    },
    {
      result: {
        action: "stop",
        task: { id: "team-1" },
        outcome: "already-stopped",
        state: "interrupted",
        resources: {},
        problems: [],
      },
      output: "Workspace for team-1 is already absent; local context was preserved.",
    },
    {
      result: {
        action: "stop",
        task: { id: "team-1" },
        outcome: "workspace-missing",
        state: "interrupted",
        resources: {},
        problems: [],
      },
      output: "Workspace for team-1 is already absent; local context was preserved.",
    },
    {
      result: {
        action: "stop",
        task: { id: "team-1" },
        outcome: "not-found",
        state: "absent",
        resources: {},
        problems: [],
      },
      output: "No run state, worktree, or live workspace found for team-1; nothing to stop.",
    },
    {
      result: {
        action: "stop",
        task: { id: "team-1" },
        outcome: "partial",
        state: "unknown",
        resources: {},
        problems: [],
      },
      output: "Stop partial for team-1",
    },
    {
      result: {
        action: "resume",
        task: { id: "team-1" },
        outcome: "resumed",
        state: "resumed",
        resources: {},
        problems: [],
      },
      output: "Resumed team-1",
    },
    {
      result: {
        action: "resume",
        task: { id: "team-1" },
        outcome: "already-running",
        state: "running",
        resources: {},
        problems: [],
      },
      output: "Workspace for team-1 is already live; no changes made.",
    },
    {
      result: {
        action: "resume",
        task: { id: "team-1" },
        outcome: "not-found",
        state: "absent",
        resources: {},
        problems: [],
      },
      output: "No worktree found for team-1; cannot resume.",
    },
    {
      result: {
        action: "resume",
        task: { id: "team-1" },
        outcome: "conflict",
        state: "unknown",
        resources: {},
        problems: [{ code: "workspace-conflict", message: "Workspace conflicts." }],
      },
      output: "Resume conflict for team-1: Workspace conflicts.",
    },
    {
      result: {
        action: "cleanup",
        task: { id: "team-1" },
        outcome: "nothing-to-clean",
        state: "absent",
        resources: { worktrees: [], workspaces: [] },
        problems: [],
      },
      output: "No worktree found for team-1; nothing to clean up.",
    },
    {
      result: {
        action: "cleanup",
        task: { id: "team-1" },
        outcome: "state-cleared",
        state: "absent",
        resources: { worktrees: [], workspaces: [] },
        problems: [],
      },
      output: "No worktree found for team-1; cleared stale run-state.",
    },
    {
      result: {
        action: "cleanup",
        task: { id: "team-1" },
        outcome: "cleaned",
        state: "absent",
        resources: {
          worktrees: [
            {
              repository: "repo-a",
              branch: "dev-team-1",
              worktreeDir: "/work/team-1",
              removed: true,
            },
          ],
          workspaces: [{ name: "team-1", closed: true }],
        },
        problems: [],
      },
      output:
        "Closed workspace team-1\n✓ Cleanup complete for team-1 (host)\n  Worktree: /work/team-1 (removed)",
    },
    {
      result: {
        action: "cleanup",
        task: { id: "team-1" },
        outcome: "partial",
        state: "unknown",
        resources: {
          worktrees: [
            {
              repository: "repo-a",
              branch: "dev-team-1",
              worktreeDir: "/work/team-1",
              removed: false,
            },
          ],
          workspaces: [{ name: "team-1", closed: false }],
        },
        problems: [{ code: "worktree-remove-failed", message: "Remove failed." }],
      },
      output: "Cleanup partial for team-1: Remove failed.",
    },
  ])("renders $result.action/$result.outcome for humans", ({ result, output }) => {
    expect(renderHuman(result)).toBe(output);
  });

  it.each<LifecycleResult>([
    {
      action: "start",
      task: { id: "team-1" },
      outcome: "partial",
      state: "running",
      resources: {},
      problems: [{ code: "task-status-update-failed", message: "Task status update failed." }],
    },
    {
      action: "cleanup",
      task: { id: "team-1" },
      outcome: "refused",
      state: "running",
      resources: { worktrees: [], workspaces: [] },
      problems: [{ code: "workspace-busy", message: "Workspace is still running." }],
    },
  ])("maps $action/$outcome to a non-zero exit", (result) => {
    expect(lifecycleResultExitCode(result)).toBe(1);
  });

  it.each<LifecycleResult>([
    {
      action: "start",
      task: { id: "team-1" },
      outcome: "already-running",
      state: "running",
      resources: {},
      problems: [],
    },
    {
      action: "stop",
      task: { id: "team-1" },
      outcome: "not-found",
      state: "absent",
      resources: {},
      problems: [],
    },
    {
      action: "cleanup",
      task: { id: "team-1" },
      outcome: "nothing-to-clean",
      state: "absent",
      resources: { worktrees: [], workspaces: [] },
      problems: [],
    },
  ])("maps $action/$outcome to a zero exit", (result) => {
    expect(lifecycleResultExitCode(result)).toBe(0);
  });
});
