import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PROMPT, launchSession, LaunchError, type WrapCommand } from "./launch.js";
import type { Presenter, PresenterOpenSpec } from "./presenter.js";
import { CREW_DONE_INSTRUCTION } from "./profiles.js";
import type { LookupExecutable } from "./shellCommand.js";

function fakePresenter(options: { openError?: Error } = {}): {
  presenter: Presenter;
  opens: PresenterOpenSpec[];
} {
  const opens: PresenterOpenSpec[] = [];
  const presenter: Presenter = {
    open: async (spec) => {
      if (options.openError !== undefined) {
        throw options.openError;
      }
      opens.push(spec);
    },
    probe: async () => ({ available: true, sessions: [] }),
    close: async () => {
      /* no-op: launch tests do not assert close */
    },
    accessHint: async () => "attach",
  };
  return { presenter, opens };
}

/** A lookup that resolves the named tokens and records what it was asked. */
function lookupFor(...runnable: string[]): { lookup: LookupExecutable; seen: string[] } {
  const seen: string[] = [];
  const paths = new Map(runnable.map((name): [string, string] => [name, `/usr/bin/${name}`]));
  const lookup: LookupExecutable = ({ name }) => {
    seen.push(name);
    return paths.get(name);
  };
  return { lookup, seen };
}

const environment = { PATH: "/usr/bin" };

describe("launchSession", () => {
  it("composes the preset command, opens at the workspace root, and returns the session name", async () => {
    const { presenter, opens } = fakePresenter();
    const { lookup } = lookupFor("claude");

    const result = await launchSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/work/fixture-task-1",
      profileName: "claude",
      profile: {},
      environment,
      presenter,
      lookup,
    });

    expect(result.sessionName).toBe("crew-fixture-task-1");
    expect(result.sessionId).toBeUndefined();
    expect(opens).toHaveLength(1);
    expect(opens[0]?.name).toBe("crew-fixture-task-1");
    expect(opens[0]?.cwd).toBe("/work/fixture-task-1");
    expect(opens[0]?.command).toBe(`claude --permission-mode auto '${CREW_DONE_INSTRUCTION}'`);
  });

  it("overlays the profile environment plus the injected correlation variables", async () => {
    const { presenter, opens } = fakePresenter();
    const { lookup } = lookupFor("scripted-agent");

    await launchSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/work/fixture-task-1",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}", environment: { MY_AGENT_VAR: "value" } },
      environment,
      presenter,
      lookup,
    });

    expect(opens[0]?.environment).toEqual({
      MY_AGENT_VAR: "value",
      GROUNDCREW_WORKSPACE: "/work/fixture-task-1",
      GROUNDCREW_TASK_ID: "fixture:TASK-1",
    });
  });

  it("uses a caller-supplied prompt over the default", async () => {
    const { presenter, opens } = fakePresenter();
    const { lookup } = lookupFor("scripted-agent");

    await launchSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}" },
      prompt: "do the thing",
      environment,
      presenter,
      lookup,
    });

    expect(opens[0]?.command).toBe("scripted-agent 'do the thing'");
  });

  it("gates on the agent executable being runnable, before touching the presenter (COMPLETE-03)", async () => {
    const { presenter, opens } = fakePresenter();
    const { lookup } = lookupFor(); // nothing runnable

    await expect(
      launchSession({
        taskId: "fixture:TASK-1",
        workspaceDirectory: "/w",
        profileName: "scripted",
        profile: { command: "missing-agent {{prompt}}" },
        environment,
        presenter,
        lookup,
      }),
    ).rejects.toThrow(LaunchError);
    expect(opens).toHaveLength(0);
  });

  it("rejects an empty composed command", async () => {
    const { presenter } = fakePresenter();
    const { lookup } = lookupFor();

    await expect(
      launchSession({
        taskId: "fixture:TASK-1",
        workspaceDirectory: "/w",
        profileName: "empty",
        profile: { command: "" },
        environment,
        presenter,
        lookup,
      }),
    ).rejects.toThrow(/produced an empty command/);
  });

  it("sandbox-wraps the command when a policy is given, gating on the pre-wrap agent token", async () => {
    const { presenter, opens } = fakePresenter();
    const { lookup, seen } = lookupFor("scripted-agent");
    const wrapCommand = vi.fn<WrapCommand>(async ({ command }) => ({ command: `srt -- ${command}` }));

    await launchSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}" },
      environment,
      policy: { writablePaths: ["/w"], readOnlyPaths: [], network: [] },
      wrapCommand,
      presenter,
      lookup,
    });

    expect(wrapCommand).toHaveBeenCalledOnce();
    expect(opens[0]?.command).toBe(`srt -- scripted-agent '${DEFAULT_PROMPT}'`);
    // The launch gate resolved the agent executable, not the sandbox wrapper.
    expect(seen).toEqual(["scripted-agent"]);
  });

  it("does not wrap when no policy is given", async () => {
    const { presenter, opens } = fakePresenter();
    const { lookup } = lookupFor("scripted-agent");
    const wrapCommand = vi.fn<WrapCommand>(async ({ command }) => ({ command: `srt -- ${command}` }));

    await launchSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}" },
      environment,
      wrapCommand,
      presenter,
      lookup,
    });

    expect(wrapCommand).not.toHaveBeenCalled();
    expect(opens[0]?.command).toBe(`scripted-agent '${DEFAULT_PROMPT}'`);
  });

  it("maps a presenter open failure to a typed LaunchError", async () => {
    const { presenter } = fakePresenter({ openError: new Error("tmux new-session failed") });
    const { lookup } = lookupFor("scripted-agent");

    await expect(
      launchSession({
        taskId: "fixture:TASK-1",
        workspaceDirectory: "/w",
        profileName: "scripted",
        profile: { command: "scripted-agent {{prompt}}" },
        environment,
        presenter,
        lookup,
      }),
    ).rejects.toThrow(LaunchError);
  });

  it("DEFAULT_PROMPT is the crew-done instruction", () => {
    expect(DEFAULT_PROMPT).toBe(CREW_DONE_INSTRUCTION);
  });
});
