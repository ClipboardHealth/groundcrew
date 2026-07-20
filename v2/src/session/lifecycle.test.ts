import { describe, expect, it } from "vitest";

import { LaunchError } from "./launch.js";
import { closeSession, pauseSession, probeSessions, resumeSession } from "./lifecycle.js";
import type { Presenter, PresenterOpenSpec, PresenterProbe } from "./presenter.js";
import { CREW_DONE_INSTRUCTION } from "./profiles.js";
import type { LookupExecutable } from "./shellCommand.js";

const EMPTY_PROBE: PresenterProbe = { available: true, sessions: [] };

function fakePresenter(probeResult: PresenterProbe = EMPTY_PROBE): {
  presenter: Presenter;
  opens: PresenterOpenSpec[];
  closes: string[];
} {
  const opens: PresenterOpenSpec[] = [];
  const closes: string[] = [];
  const presenter: Presenter = {
    open: async (spec) => {
      opens.push(spec);
    },
    probe: async () => probeResult,
    close: async (name) => {
      closes.push(name);
    },
    accessHint: async () => "attach",
  };
  return { presenter, opens, closes };
}

const runnable: LookupExecutable = ({ name }) => `/usr/bin/${name}`;
const noPaths = new Map<string, string>();
const notRunnable: LookupExecutable = ({ name }) => noPaths.get(name);
const environment = { PATH: "/usr/bin" };

describe("pauseSession / closeSession", () => {
  it("pause closes the presenter surface by session name", async () => {
    const { presenter, closes } = fakePresenter();

    await pauseSession({ taskId: "fixture:TASK-1", presenter });

    expect(closes).toEqual(["crew-fixture-task-1"]);
  });

  it("close closes the presenter surface by session name", async () => {
    const { presenter, closes } = fakePresenter();

    await closeSession({ taskId: "fixture:TASK-1", presenter });

    expect(closes).toEqual(["crew-fixture-task-1"]);
  });
});

describe("probeSessions", () => {
  it("passes the presenter probe result through unchanged", async () => {
    const probeResult: PresenterProbe = {
      available: true,
      sessions: [{ name: "crew-fixture-task-1", alive: true }],
    };
    const { presenter } = fakePresenter(probeResult);

    expect(await probeSessions({ presenter })).toEqual(probeResult);
  });
});

describe("resumeSession", () => {
  it("reopens the same session name with the preset built-in resume form", async () => {
    const { presenter, opens } = fakePresenter();

    const result = await resumeSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "claude",
      profile: {},
      environment,
      presenter,
      lookup: runnable,
    });

    expect(result.sessionName).toBe("crew-fixture-task-1");
    expect(opens[0]?.name).toBe("crew-fixture-task-1");
    expect(opens[0]?.command).toBe("claude --permission-mode auto --continue");
  });

  it("substitutes a captured session id into a custom profile's resume template", async () => {
    const { presenter, opens } = fakePresenter();

    await resumeSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}", resume: "scripted-agent --resume {{sessionId}}" },
      sessionId: "abc123",
      environment,
      presenter,
      lookup: runnable,
    });

    expect(opens[0]?.command).toBe("scripted-agent --resume 'abc123'");
  });

  it("ignores the captured id under fresh", async () => {
    const { presenter, opens } = fakePresenter();

    await resumeSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}", resume: "scripted-agent --resume {{sessionId}}" },
      sessionId: "abc123",
      fresh: true,
      environment,
      presenter,
      lookup: runnable,
    });

    expect(opens[0]?.command).toBe("scripted-agent --resume");
  });

  it("falls back to a fresh launch when a custom profile has no resume form", async () => {
    const { presenter, opens } = fakePresenter();

    await resumeSession({
      taskId: "fixture:TASK-1",
      workspaceDirectory: "/w",
      profileName: "scripted",
      profile: { command: "scripted-agent {{prompt}}" },
      environment,
      presenter,
      lookup: runnable,
    });

    expect(opens[0]?.command).toBe(`scripted-agent '${CREW_DONE_INSTRUCTION}'`);
  });

  it("applies the same launch gate as the initial launch", async () => {
    const { presenter } = fakePresenter();

    await expect(
      resumeSession({
        taskId: "fixture:TASK-1",
        workspaceDirectory: "/w",
        profileName: "scripted",
        profile: { command: "scripted-agent {{prompt}}", resume: "scripted-agent --resume {{sessionId}}" },
        environment,
        presenter,
        lookup: notRunnable,
      }),
    ).rejects.toThrow(LaunchError);
  });
});
