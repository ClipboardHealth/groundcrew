import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTaskContext } from "./context.js";
import { NoTaskContextError } from "./errors.js";
import { provisionWorkspace } from "./provision.js";
import { workspacePath, type WorkspaceConfig } from "./paths.js";
import { makeSandbox, type Sandbox } from "./testRepos.js";

const TASK_ID = "fixture:TASK-1";

describe("resolveTaskContext", () => {
  let sandbox: Sandbox;
  let config: WorkspaceConfig;
  let workspaceDirectory: string;

  beforeEach(async () => {
    sandbox = makeSandbox();
    config = { baseDirectory: sandbox.baseDirectory };
    await provisionWorkspace({ config, taskId: TASK_ID });
    workspaceDirectory = workspacePath({ config, taskId: TASK_ID });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("resolves from an explicit --task id, reading the marker when present", () => {
    const context = resolveTaskContext({
      explicitTaskId: TASK_ID,
      environment: {},
      cwd: sandbox.baseDirectory,
      config,
    });

    expect(context.taskId).toBe(TASK_ID);
    expect(context.workspaceDirectory).toBe(workspaceDirectory);
    expect(context.marker?.taskId).toBe(TASK_ID);
  });

  it("resolves --task even when the workspace has no marker yet", () => {
    const context = resolveTaskContext({
      explicitTaskId: "fixture:UNPROVISIONED",
      environment: {},
      cwd: sandbox.baseDirectory,
      config,
    });

    expect(context.taskId).toBe("fixture:UNPROVISIONED");
    expect(context.marker).toBeUndefined();
  });

  it("resolves from $GROUNDCREW_WORKSPACE", () => {
    const context = resolveTaskContext({
      environment: { GROUNDCREW_WORKSPACE: workspaceDirectory },
      cwd: sandbox.baseDirectory,
      config,
    });

    expect(context.taskId).toBe(TASK_ID);
    expect(context.workspaceDirectory).toBe(workspaceDirectory);
  });

  it("walks up from cwd to the nearest .groundcrew/task.json", () => {
    const context = resolveTaskContext({
      environment: {},
      cwd: path.join(workspaceDirectory, "alpha", "src"),
      config,
    });

    expect(context.taskId).toBe(TASK_ID);
    expect(context.workspaceDirectory).toBe(workspaceDirectory);
  });

  it("prefers --task over the environment and cwd", () => {
    const context = resolveTaskContext({
      explicitTaskId: "fixture:OVERRIDE",
      environment: { GROUNDCREW_WORKSPACE: workspaceDirectory },
      cwd: workspaceDirectory,
      config,
    });

    expect(context.taskId).toBe("fixture:OVERRIDE");
  });

  it("ignores $GROUNDCREW_WORKSPACE with no marker and falls through to the walk-up", () => {
    const context = resolveTaskContext({
      environment: { GROUNDCREW_WORKSPACE: path.join(sandbox.root, "no-marker-here") },
      cwd: workspaceDirectory,
      config,
    });

    expect(context.taskId).toBe(TASK_ID);
  });

  it("throws NoTaskContextError when nothing resolves", () => {
    expect(() =>
      resolveTaskContext({ environment: {}, cwd: sandbox.baseDirectory, config }),
    ).toThrow(NoTaskContextError);
  });
});
