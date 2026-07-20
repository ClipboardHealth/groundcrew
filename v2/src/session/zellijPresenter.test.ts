/**
 * zellij presenter unit tests. zellij is not installed on the dev/CI host, so
 * every branch runs through an injected `ExecFn` with composed-argv assertions —
 * the adapter's live launch path is intentionally unvalidated for v2.0.
 */

import { describe, expect, it } from "vitest";

import type { ExecFn, ExecInput, ExecResult } from "./exec.js";
import { createZellijPresenter } from "./zellijPresenter.js";

function recorder(
  handler: (input: ExecInput) => Partial<ExecResult>,
): { exec: ExecFn; calls: ExecInput[] } {
  const calls: ExecInput[] = [];
  const exec: ExecFn = async (input) => {
    calls.push(input);
    return { exitCode: 0, stdout: "", stderr: "", spawnFailed: false, ...handler(input) };
  };
  return { exec, calls };
}

describe("createZellijPresenter open", () => {
  it("creates a detached session then runs the command in it (validated live, zellij 0.44)", async () => {
    const { exec, calls } = recorder(() => ({}));
    const presenter = createZellijPresenter({ exec });

    await presenter.open({
      name: "crew-alpha",
      cwd: "/work/alpha",
      command: "scripted-agent 'go'",
      environment: { GROUNDCREW_TASK_ID: "fixture:TASK-1" },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "zellij",
      args: ["attach", "--create-background", "crew-alpha"],
      cwd: "/work/alpha",
      env: { GROUNDCREW_TASK_ID: "fixture:TASK-1" },
    });
    expect(calls[1]).toMatchObject({
      command: "zellij",
      args: [
        "--session",
        "crew-alpha",
        "run",
        "--cwd",
        "/work/alpha",
        "--",
        "sh",
        "-c",
        "scripted-agent 'go'",
      ],
      cwd: "/work/alpha",
      env: { GROUNDCREW_TASK_ID: "fixture:TASK-1" },
    });
  });

  it("throws when the launch exits non-zero", async () => {
    const { exec } = recorder(() => ({ exitCode: 1, stderr: "nope" }));
    const presenter = createZellijPresenter({ exec });

    await expect(presenter.open({ name: "crew-x", cwd: "/w", command: "run" })).rejects.toThrow(
      /zellij session launch failed for "crew-x": nope/,
    );
  });

  it("throws when zellij cannot be spawned", async () => {
    const { exec } = recorder(() => ({ exitCode: 127, spawnFailed: true }));
    const presenter = createZellijPresenter({ exec });

    await expect(presenter.open({ name: "crew-x", cwd: "/w", command: "run" })).rejects.toThrow(
      /not runnable/,
    );
  });
});

describe("createZellijPresenter probe", () => {
  it("parses short session names and filters to managed ones", async () => {
    const { exec } = recorder(() => ({ stdout: "crew-alpha\ncrew-beta\nsomeones-editor\n" }));
    const presenter = createZellijPresenter({ exec });

    const probe = await presenter.probe();

    expect(probe).toEqual({
      available: true,
      sessions: [
        { name: "crew-alpha", alive: true },
        { name: "crew-beta", alive: true },
      ],
    });
  });

  it("treats the no-active-sessions signature as a definitive empty", async () => {
    const { exec } = recorder(() => ({
      exitCode: 1,
      stderr: "No active zellij sessions found.",
    }));
    const presenter = createZellijPresenter({ exec });

    expect(await presenter.probe()).toEqual({ available: true, sessions: [] });
  });

  it("reports available:false on an unexpected non-zero exit", async () => {
    const { exec } = recorder(() => ({ exitCode: 2, stderr: "broken" }));
    const presenter = createZellijPresenter({ exec });

    expect(await presenter.probe()).toEqual({ available: false, sessions: [] });
  });

  it("reports available:false when zellij cannot be spawned", async () => {
    const { exec } = recorder(() => ({ exitCode: 127, spawnFailed: true }));
    const presenter = createZellijPresenter({ exec });

    expect(await presenter.probe()).toEqual({ available: false, sessions: [] });
  });
});

describe("createZellijPresenter close", () => {
  it("kills the session by name", async () => {
    const { exec, calls } = recorder(() => ({}));
    const presenter = createZellijPresenter({ exec });

    await presenter.close("crew-alpha");

    expect(calls[0]?.args).toEqual(["kill-session", "crew-alpha"]);
  });

  it("swallows an already-gone session", async () => {
    const { exec } = recorder(() => ({
      exitCode: 1,
      stderr: "No session named crew-alpha found",
    }));
    const presenter = createZellijPresenter({ exec });

    await expect(presenter.close("crew-alpha")).resolves.toBeUndefined();
  });

  it("throws on an unexpected close failure", async () => {
    const { exec } = recorder(() => ({ exitCode: 1, stderr: "server error" }));
    const presenter = createZellijPresenter({ exec });

    await expect(presenter.close("crew-alpha")).rejects.toThrow(/zellij kill-session failed/);
  });
});

describe("createZellijPresenter surface", () => {
  it("emits an attach hint and omits setStatus (capability by omission)", async () => {
    const { exec } = recorder(() => ({}));
    const presenter = createZellijPresenter({ exec });

    expect(await presenter.accessHint("crew-alpha")).toMatch(/^ZELLIJ_SOCKET_DIR=\S+ zellij attach crew-alpha$/u);
    expect(presenter.setStatus).toBeUndefined();
  });
});
