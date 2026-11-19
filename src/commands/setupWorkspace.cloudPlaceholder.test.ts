import { agentTrustDir } from "agent-trust";

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { launchCloudSession } from "../lib/cloudLauncher.ts";
import { DEFAULT_CLOUD_PROMPT_INITIAL } from "../lib/cloudPrompt.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState } from "../lib/runState.ts";
import type * as utilModule from "../lib/util.ts";
import { log } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { worktrees, type WorktreeEntry } from "../lib/worktrees.ts";
import { makeCmuxConfig } from "../testHelpers/cmuxConfig.ts";
import { makeExecutionConfig } from "../testHelpers/executionConfig.ts";
import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { setupWorkspace, type SetupWorkspaceOptions } from "./setupWorkspace.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/cloudLauncher.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, launchCloudSession: vi.fn<typeof actual.launchCloudSession>() };
});
vi.mock(import("agent-trust"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("agent-trust")>();
  return { ...actual, agentTrustDir: vi.fn<typeof agentTrustDir>() };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    recordRunState: vi.fn<typeof recordRunState>(),
  };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: { ...actual.workspaces, open: vi.fn<typeof actual.workspaces.open>() },
  };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return { ...actual, log: vi.fn<typeof actual.log>(), debug: vi.fn<typeof actual.debug>() };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      create: vi.fn<typeof actual.worktrees.create>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      predictedEntry: vi.fn<typeof actual.worktrees.predictedEntry>(),
    },
  };
});

const agentTrustDirMock = vi.mocked(agentTrustDir);
const logMock = vi.mocked(log);
const launchCloudSessionMock = vi.mocked(launchCloudSession);
const createMock = vi.mocked(worktrees.create);
const openMock = vi.mocked(workspaces.open);
const recordRunStateMock = vi.mocked(recordRunState);

const cloudOptions: SetupWorkspaceOptions = {
  task: "team-1",
  repository: "repo-a",
  agent: "claude",
  details: { title: "Cloud Title", description: "Do the cloud thing" },
};

const entry: WorktreeEntry = {
  repository: "repo-a",
  task: "team-1",
  branchName: "dev-team-1",
  dir: "/work/repo-a-team-1",
  kind: "host",
};

function makeCloudConfig(): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff", execution: "cloud" } },
    },
    execution: makeExecutionConfig(),
    remoteControl: { enabled: false },
    prompts: { initial: "x", cloudInitial: DEFAULT_CLOUD_PROMPT_INITIAL },
    workspaceKind: "auto",
    local: makeLocalConfig(),
    cmux: makeCmuxConfig(),
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function printedBanner(command: string | undefined): string {
  return spawnSync("sh", ["-c", command ?? ""], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], SHELL: "/usr/bin/true" },
  }).stdout;
}

const session = { sessionId: "session_abc", url: "https://claude.ai/code/session_abc" };

describe("setupWorkspace cloud placeholder workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runCommandMock.mockReturnValue("");
    agentTrustDirMock.mockReturnValue({ ok: true } as ReturnType<typeof agentTrustDir>);
    createMock.mockResolvedValue(entry);
    launchCloudSessionMock.mockResolvedValue(session);
    vi.mocked(worktrees.findByTask).mockReturnValue([]);
    vi.mocked(worktrees.predictedEntry).mockReturnValue({
      worktreeDir: entry.dir,
      branchName: entry.branchName,
    });
    vi.mocked(worktrees.teardown).mockResolvedValue(emptyTeardownResult());
  });

  it("opens a workspace named for the task in the launch dir with the stub command", async () => {
    await setupWorkspace(makeCloudConfig(), cloudOptions);

    expect(openMock).toHaveBeenCalledTimes(1);
    const [, spec] = openMock.mock.calls[0] ?? [];
    expect(spec).toMatchObject({ name: "team-1", cwd: entry.dir });
    expect(printedBanner(spec?.command)).toContain(session.url);
    expect(printedBanner(spec?.command)).toContain("'resume' 'team-1'");
    expect(spec?.status).toBeUndefined();
  });

  it("passes a short bash command and stages the stub in a launch script", async () => {
    await setupWorkspace(makeCloudConfig(), cloudOptions);

    const command = openMock.mock.calls[0]?.[1].command ?? "";
    const scriptPath = /^bash '(?<script>[^']+)'$/.exec(command)?.groups?.["script"];
    expect(scriptPath).toMatch(/groundcrew-cloud-team-1-[^/]+\/launch\.sh$/);
    const script = readFileSync(scriptPath ?? "", "utf8");
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain(session.url);
    expect(script).toContain("running · cloud");
    expect(script).toContain("clear 2>/dev/null || true");
    rmSync(path.dirname(scriptPath ?? ""), { recursive: true, force: true });
  });

  it("opens the placeholder only after the run is recorded as running", async () => {
    await setupWorkspace(makeCloudConfig(), cloudOptions);

    const runningCallIndex = recordRunStateMock.mock.calls.findIndex(
      ([input]) => input.state.state === "running",
    );
    expect(recordRunStateMock.mock.invocationCallOrder[runningCallIndex]).toBeLessThan(
      openMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("links the task url and uses the title as panel name when configured", async () => {
    const config = makeCloudConfig();
    config.workspace.useTaskTitleForPanelName = true;

    await setupWorkspace(config, {
      ...cloudOptions,
      details: { ...cloudOptions.details, url: "https://linear.app/x/issue/TEAM-1" },
    });

    expect(openMock.mock.calls[0]?.[1]).toMatchObject({
      displayName: "Cloud Title",
      url: "https://linear.app/x/issue/TEAM-1",
    });
  });

  it("omits the panel name and url when neither is available", async () => {
    await setupWorkspace(makeCloudConfig(), cloudOptions);

    const [, spec] = openMock.mock.calls[0] ?? [];
    expect(spec).not.toHaveProperty("displayName");
    expect(spec).not.toHaveProperty("url");
  });

  it("forwards the abort signal to the workspace open", async () => {
    const controller = new AbortController();

    await setupWorkspace(makeCloudConfig(), cloudOptions, { signal: controller.signal });

    expect(openMock.mock.calls[0]?.[2]).toBe(controller.signal);
  });

  it("falls back to the crew binary name when the entrypoint script is unknown", async () => {
    const originalArgv = process.argv;
    process.argv = [process.execPath];
    try {
      await setupWorkspace(makeCloudConfig(), cloudOptions);
    } finally {
      process.argv = originalArgv;
    }

    expect(printedBanner(openMock.mock.calls[0]?.[1].command)).toContain(
      "'crew' 'resume' 'team-1'",
    );
  });

  it("keeps the cloud run and warns with the task when the placeholder fails to open", async () => {
    openMock.mockRejectedValue(new Error("cmux down"));

    await expect(setupWorkspace(makeCloudConfig(), cloudOptions)).resolves.toBeUndefined();

    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not open the cloud placeholder workspace for team-1: cmux down",
      ),
    );
    expect(worktrees.teardown).not.toHaveBeenCalled();
    const states = recordRunStateMock.mock.calls.map(([input]) => input.state.state);
    expect(states).toContain("running");
    expect(states).not.toContain("failed-to-launch");
  });

  it("opens no placeholder when the cloud launch fails", async () => {
    launchCloudSessionMock.mockRejectedValue(new Error("launch failed"));

    await expect(setupWorkspace(makeCloudConfig(), cloudOptions)).rejects.toThrow("launch failed");

    expect(openMock).not.toHaveBeenCalled();
  });
});
