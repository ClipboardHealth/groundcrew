/**
 * Real tmux integration tests for the tmux presenter. Every test runs against
 * an isolated, uniquely-named socket (`-L modsession-…`) and kills its server
 * in `afterEach`, so these never touch the host's default tmux server or any
 * other agent's e2e sockets. The failure-signature branches (which need a
 * missing or broken tmux) are driven through an injected `ExecFn` instead.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExecFn } from "./exec.js";
import { runProcess } from "./exec.js";
import { createTmuxPresenter } from "./tmuxPresenter.js";

let socketCounter = 0;
const activeSockets = new Set<string>();
const tempDirectories: string[] = [];

function uniqueSocket(): string {
  socketCounter += 1;
  const socket = `modsession-${process.pid}-${socketCounter}`;
  activeSockets.add(socket);
  return socket;
}

function tempWorkspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "modsession-tmux-"));
  tempDirectories.push(directory);
  return directory;
}

async function rawTmux(socket: string, args: readonly string[]): Promise<void> {
  await runProcess({ command: "tmux", args: ["-L", socket, ...args] });
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling a real tmux server is inherently sequential
    if (await condition()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling a real tmux server is inherently sequential
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("condition not met within 5s");
}

afterEach(async () => {
  await Promise.all(
    [...activeSockets].map(async (socket) => {
      await runProcess({ command: "tmux", args: ["-L", socket, "kill-server"] });
    }),
  );
  activeSockets.clear();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createTmuxPresenter (real tmux)", () => {
  it("opens a detached session and probe reports it alive", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });
    const cwd = tempWorkspace();

    await presenter.open({ name: "crew-alpha", cwd, command: "sleep 30" });

    const probe = await presenter.probe();
    expect(probe.available).toBe(true);
    expect(probe.sessions).toEqual([{ name: "crew-alpha", alive: true }]);
  });

  it("probe returns only sessions following the crew- naming scheme", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });
    const cwd = tempWorkspace();

    await presenter.open({ name: "crew-beta", cwd, command: "sleep 30" });
    await rawTmux(socket, ["new-session", "-d", "-s", "someones-editor", "sleep 30"]);

    const probe = await presenter.probe();

    expect(probe.sessions.map((session) => session.name)).toEqual(["crew-beta"]);
  });

  it("injects the overlay environment into the session", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });
    const cwd = tempWorkspace();
    const marker = path.join(cwd, "env-marker");

    await presenter.open({
      name: "crew-env",
      cwd,
      command: `sh -c 'printf %s "$MODSESSION_VAR" > ${marker}; exec sleep 30'`,
      environment: { MODSESSION_VAR: "hello-env" },
    });

    await waitFor(async () => {
      try {
        return readFileSync(marker, "utf8") === "hello-env";
      } catch {
        return false;
      }
    });
    expect(readFileSync(marker, "utf8")).toBe("hello-env");
  });

  it("runs the session at the requested cwd", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });
    const cwd = tempWorkspace();
    const marker = path.join(cwd, "pwd-marker");

    await presenter.open({
      name: "crew-cwd",
      cwd,
      command: `sh -c 'pwd -P > ${marker}; exec sleep 30'`,
    });

    await waitFor(async () => {
      try {
        readFileSync(marker, "utf8");
        return true;
      } catch {
        return false;
      }
    });
    const observed = readFileSync(marker, "utf8").trim();
    expect(observed).toBe(realpathSync(cwd));
  });

  it("close kills the session and is idempotent when already gone", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });
    const cwd = tempWorkspace();

    await presenter.open({ name: "crew-gamma", cwd, command: "sleep 30" });
    await presenter.close("crew-gamma");

    await waitFor(async () => (await presenter.probe()).sessions.length === 0);
    // Second close does not throw even though the session is gone.
    await expect(presenter.close("crew-gamma")).resolves.toBeUndefined();
  });

  it("open throws when tmux rejects a duplicate session name", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });
    const cwd = tempWorkspace();

    await presenter.open({ name: "crew-dup", cwd, command: "sleep 30" });

    await expect(presenter.open({ name: "crew-dup", cwd, command: "sleep 30" })).rejects.toThrow(
      /tmux new-session failed/,
    );
  });

  it("probe on a reachable-but-serverless socket is an honest empty", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });

    const probe = await presenter.probe();

    expect(probe).toEqual({ available: true, sessions: [] });
  });

  it("accessHint carries the -L socket so a human can attach", async () => {
    const socket = uniqueSocket();
    const presenter = createTmuxPresenter({ socket });

    expect(await presenter.accessHint("crew-alpha")).toBe(`tmux -L ${socket} attach -t crew-alpha`);
  });

  it("does not implement setStatus (tmux cannot paint)", () => {
    const presenter = createTmuxPresenter({ socket: uniqueSocket() });

    expect(presenter.setStatus).toBeUndefined();
  });
});

const failingExec: ExecFn = async () => ({
  exitCode: 7,
  stdout: "",
  stderr: "tmux down",
  spawnFailed: false,
});
const missingExec: ExecFn = async () => ({
  exitCode: 127,
  stdout: "",
  stderr: "spawn tmux ENOENT",
  spawnFailed: true,
});
const noServerExec: ExecFn = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "no server running on /tmp/tmux",
  spawnFailed: false,
});
const goneExec: ExecFn = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "can't find session: crew-x",
  spawnFailed: false,
});

describe("createTmuxPresenter (injected exec failure branches)", () => {
  it("probe reports unavailable when tmux exits non-zero without the no-server signature", async () => {
    const presenter = createTmuxPresenter({ exec: failingExec, socket: "s" });

    expect(await presenter.probe()).toEqual({ available: false, sessions: [] });
  });

  it("probe reports unavailable when tmux cannot be spawned", async () => {
    const presenter = createTmuxPresenter({ exec: missingExec, socket: "s" });

    expect(await presenter.probe()).toEqual({ available: false, sessions: [] });
  });

  it("probe treats a no-server stderr as a definitive empty", async () => {
    const presenter = createTmuxPresenter({ exec: noServerExec, socket: "s" });

    expect(await presenter.probe()).toEqual({ available: true, sessions: [] });
  });

  it("open throws when the tmux binary is missing", async () => {
    const presenter = createTmuxPresenter({ exec: missingExec, socket: "s" });

    await expect(presenter.open({ name: "crew-x", cwd: "/tmp", command: "sleep 1" })).rejects.toThrow(
      /tmux new-session failed/,
    );
  });

  it("close surfaces an unexpected failure", async () => {
    const presenter = createTmuxPresenter({ exec: failingExec, socket: "s" });

    await expect(presenter.close("crew-x")).rejects.toThrow(/tmux kill-session failed/);
  });

  it("close swallows an already-gone session", async () => {
    const presenter = createTmuxPresenter({ exec: goneExec, socket: "s" });

    await expect(presenter.close("crew-x")).resolves.toBeUndefined();
  });
});
