/**
 * cmux presenter unit tests. cmux is the macOS TUI and not drivable in CI, so
 * every branch runs through an injected `ExecFn` with composed-argv assertions
 * and scripted `list-workspaces` JSON (the shape captured from the real cmux on
 * the dev host).
 */

import { describe, expect, it } from "vitest";

import { createCmuxPresenter } from "./cmuxPresenter.js";
import type { ExecFn, ExecInput, ExecResult } from "./exec.js";

interface Workspace {
  ref?: string;
  id?: string;
  title?: string;
  description?: string | null;
}

function listJson(workspaces: Workspace[]): string {
  return JSON.stringify({ window_ref: "window:1", workspaces });
}

function verb(input: ExecInput): string {
  for (const candidate of ["list-workspaces", "new-workspace", "close-workspace", "set-status"]) {
    if (input.args.includes(candidate)) {
      return candidate;
    }
  }
  return "";
}

/** One canned response for every cmux invocation. */
function recorder(response: Partial<ExecResult>): { exec: ExecFn; calls: ExecInput[] } {
  const calls: ExecInput[] = [];
  const exec: ExecFn = async (input) => {
    calls.push(input);
    return { exitCode: 0, stdout: "", stderr: "", spawnFailed: false, ...response };
  };
  return { exec, calls };
}

/** A per-verb response map; unlisted verbs succeed with empty output. */
function routed(routes: Record<string, Partial<ExecResult>>): { exec: ExecFn; calls: ExecInput[] } {
  const calls: ExecInput[] = [];
  const exec: ExecFn = async (input) => {
    calls.push(input);
    const response = routes[verb(input)] ?? {};
    return { exitCode: 0, stdout: "", stderr: "", spawnFailed: false, ...response };
  };
  return { exec, calls };
}

function callWith(calls: ExecInput[], wanted: string): ExecInput | undefined {
  return calls.find((call) => verb(call) === wanted);
}

const managedList = listJson([{ ref: "workspace:2", title: "x", description: "groundcrew:crew-alpha" }]);

describe("createCmuxPresenter open", () => {
  it("composes new-workspace with name, cwd, command, marker, and env flags", async () => {
    const { exec, calls } = recorder({ stdout: JSON.stringify({ workspace_ref: "workspace:9" }) });
    const presenter = createCmuxPresenter({ exec });

    await presenter.open({
      name: "crew-alpha",
      displayName: "Fix the bug",
      cwd: "/work/alpha",
      command: "scripted-agent 'go'",
      environment: { MY_VAR: "value", OTHER: "x" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "--json",
      "new-workspace",
      "--name",
      "Fix the bug",
      "--cwd",
      "/work/alpha",
      "--command",
      "scripted-agent 'go'",
      "--description",
      "groundcrew:crew-alpha",
      "--env",
      "MY_VAR=value",
      "--env",
      "OTHER=x",
    ]);
  });

  it("falls back to the session name when no displayName is given", async () => {
    const { exec, calls } = recorder({ stdout: "{}" });
    const presenter = createCmuxPresenter({ exec });

    await presenter.open({ name: "crew-beta", cwd: "/work/beta", command: "run" });

    expect(calls[0]?.args[3]).toBe("crew-beta");
  });

  it("throws when new-workspace exits non-zero", async () => {
    const { exec } = recorder({ exitCode: 1, stderr: "boom" });
    const presenter = createCmuxPresenter({ exec });

    await expect(presenter.open({ name: "crew-x", cwd: "/w", command: "run" })).rejects.toThrow(
      /cmux new-workspace failed for "crew-x": boom/,
    );
  });

  it("throws when cmux cannot be spawned", async () => {
    const { exec } = recorder({ exitCode: 127, spawnFailed: true });
    const presenter = createCmuxPresenter({ exec });

    await expect(presenter.open({ name: "crew-x", cwd: "/w", command: "run" })).rejects.toThrow(
      /not runnable/,
    );
  });

  it("paints the initial status pill best-effort from the created ref", async () => {
    const { exec, calls } = routed({
      "new-workspace": { stdout: JSON.stringify({ workspace_ref: "workspace:12" }) },
    });
    const presenter = createCmuxPresenter({ exec });

    await presenter.open({ name: "crew-alpha", cwd: "/w", command: "run", status: "working" });

    expect(callWith(calls, "set-status")?.args).toEqual([
      "set-status",
      "agent",
      "working",
      "--workspace",
      "workspace:12",
    ]);
  });

  it("does not fail the launch when the best-effort status pill errors", async () => {
    const { exec } = routed({
      "new-workspace": { stdout: JSON.stringify({ workspace_ref: "workspace:12" }) },
      "set-status": { exitCode: 1, stderr: "no set-status" },
    });
    const presenter = createCmuxPresenter({ exec });

    await expect(
      presenter.open({ name: "crew-alpha", cwd: "/w", command: "run", status: "working" }),
    ).resolves.toBeUndefined();
  });
});

describe("createCmuxPresenter probe", () => {
  it("reports available:false when list-workspaces fails", async () => {
    const { exec } = recorder({ exitCode: 1, stderr: "cannot connect" });
    const presenter = createCmuxPresenter({ exec });

    expect(await presenter.probe()).toEqual({ available: false, sessions: [] });
  });

  it("reports available:false when cmux cannot be spawned", async () => {
    const { exec } = recorder({ exitCode: 127, spawnFailed: true });
    const presenter = createCmuxPresenter({ exec });

    expect(await presenter.probe()).toEqual({ available: false, sessions: [] });
  });

  it("keys identity on the description marker, then the title, filtering to managed names", async () => {
    const { exec } = recorder({
      stdout: listJson([
        { ref: "workspace:1", title: "crew v2", description: null },
        { ref: "workspace:2", title: "renamed panel", description: "groundcrew:crew-alpha" },
        { ref: "workspace:3", title: "crew-beta", description: null },
        { ref: "workspace:4", title: "someones-editor", description: null },
      ]),
    });
    const presenter = createCmuxPresenter({ exec });

    const probe = await presenter.probe();

    expect(probe.available).toBe(true);
    expect(probe.sessions).toEqual([
      { name: "crew-alpha", alive: true },
      { name: "crew-beta", alive: true },
    ]);
  });

  it("is an honest empty when cmux reports no workspaces", async () => {
    const { exec } = recorder({ stdout: listJson([]) });
    const presenter = createCmuxPresenter({ exec });

    expect(await presenter.probe()).toEqual({ available: true, sessions: [] });
  });
});

describe("createCmuxPresenter close", () => {
  it("resolves the ref by managed name and closes it", async () => {
    const { exec, calls } = routed({ "list-workspaces": { stdout: managedList } });
    const presenter = createCmuxPresenter({ exec });

    await presenter.close("crew-alpha");

    expect(callWith(calls, "close-workspace")?.args).toEqual([
      "close-workspace",
      "--workspace",
      "workspace:2",
    ]);
  });

  it("is an idempotent no-op when no workspace matches", async () => {
    const { exec, calls } = routed({
      "list-workspaces": {
        stdout: listJson([{ ref: "workspace:9", title: "crew-other", description: null }]),
      },
    });
    const presenter = createCmuxPresenter({ exec });

    await expect(presenter.close("crew-alpha")).resolves.toBeUndefined();
    expect(callWith(calls, "close-workspace")).toBeUndefined();
  });

  it("throws when the workspace list is unavailable", async () => {
    const { exec } = recorder({ exitCode: 1, stderr: "down" });
    const presenter = createCmuxPresenter({ exec });

    await expect(presenter.close("crew-alpha")).rejects.toThrow(/could not list workspaces/);
  });

  it("throws when close-workspace itself fails", async () => {
    const { exec } = routed({
      "list-workspaces": { stdout: managedList },
      "close-workspace": { exitCode: 1, stderr: "still open" },
    });
    const presenter = createCmuxPresenter({ exec });

    await expect(presenter.close("crew-alpha")).rejects.toThrow(/cmux close-workspace failed/);
  });
});

describe("createCmuxPresenter accessHint and setStatus", () => {
  it("returns workspace-name guidance for the TUI", async () => {
    const { exec } = recorder({});
    const presenter = createCmuxPresenter({ exec });

    expect(await presenter.accessHint("crew-alpha")).toBe(
      'Open the cmux app and select the "crew-alpha" workspace.',
    );
  });

  it("implements setStatus (capability by presence)", () => {
    const { exec } = recorder({});
    const presenter = createCmuxPresenter({ exec });

    expect(presenter.setStatus).toBeDefined();
  });

  it("composes set-status with icon and color against the resolved ref", async () => {
    const { exec, calls } = routed({
      "list-workspaces": {
        stdout: listJson([{ ref: "workspace:5", title: "x", description: "groundcrew:crew-alpha" }]),
      },
    });
    const presenter = createCmuxPresenter({ exec });

    await presenter.setStatus?.("crew-alpha", { text: "running", icon: "sparkle", color: "#ff9500" });

    expect(callWith(calls, "set-status")?.args).toEqual([
      "set-status",
      "agent",
      "running",
      "--icon",
      "sparkle",
      "--color",
      "#ff9500",
      "--workspace",
      "workspace:5",
    ]);
  });

  it("is a no-op when the target workspace is absent", async () => {
    const { exec, calls } = routed({ "list-workspaces": { stdout: listJson([]) } });
    const presenter = createCmuxPresenter({ exec });

    await presenter.setStatus?.("crew-alpha", { text: "running" });

    expect(callWith(calls, "set-status")).toBeUndefined();
  });
});
