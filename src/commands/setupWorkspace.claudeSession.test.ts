import { readFileSync } from "node:fs";

import { agentTrustDir } from "agent-trust";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import {
  CLOUD_RUN_STATE_FIELDS,
  LOCAL_CLAUDE_SESSION_STATE_FIELDS,
  readRunState,
  recordRunState,
} from "../lib/runState.ts";
import { workspaces } from "../lib/workspaces.ts";
import { worktrees, type WorktreeEntry } from "../lib/worktrees.ts";
import { makeCmuxConfig } from "../testHelpers/cmuxConfig.ts";
import { makeExecutionConfig } from "../testHelpers/executionConfig.ts";
import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { setupWorkspace } from "./setupWorkspace.ts";

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
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
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

const host: HostCapabilities = {
  hasSafehouse: false,
  hasSbx: false,
  hasCmux: false,
  hasTmux: true,
  hasZellij: false,
  isMacOS: true,
  isLinux: false,
  isSafehouseSupported: true,
  isSdxSupported: true,
};

const entry: WorktreeEntry = {
  repository: "repo-a",
  task: "team-1",
  branchName: "dev-team-1",
  dir: "/work/repo-a-team-1",
  kind: "host",
};

function makeConfig(remoteControlEnabled: boolean): ResolvedConfig {
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
      definitions: {
        claude: { cmd: "claude --permission-mode auto", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
    },
    execution: makeExecutionConfig(),
    remoteControl: { enabled: remoteControlEnabled },
    prompts: { initial: "Begin {{task}}", cloudInitial: "x" },
    workspaceKind: "tmux",
    local: makeLocalConfig({ runner: "none" }),
    cmux: makeCmuxConfig(),
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function launchedScript(): string {
  const command = vi.mocked(workspaces.open).mock.calls[0]?.[1].command ?? "";
  const scriptPath = /'([^']+launch\.sh)'/.exec(command)?.[1];
  return readFileSync(scriptPath ?? "", "utf8");
}

function recordedRunningState(): Parameters<typeof recordRunState>[0]["state"] | undefined {
  return vi
    .mocked(recordRunState)
    .mock.calls.map(([input]) => input.state)
    .find((state) => state.state === "running");
}

async function launch(input: { remoteControlEnabled: boolean; agent: string }): Promise<void> {
  await setupWorkspace(makeConfig(input.remoteControlEnabled), {
    task: "team-1",
    repository: "repo-a",
    agent: input.agent,
    details: { title: "Title", description: "Body" },
  });
}

describe("setupWorkspace claude session pinning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runCommandMock.mockReturnValue("");
    vi.mocked(detectHostCapabilities).mockResolvedValue(host);
    vi.mocked(agentTrustDir).mockReturnValue({ ok: true } as ReturnType<typeof agentTrustDir>);
    vi.mocked(worktrees.create).mockResolvedValue(entry);
    vi.mocked(worktrees.findByTask).mockReturnValue([]);
    vi.mocked(worktrees.predictedEntry).mockReturnValue({
      worktreeDir: entry.dir,
      branchName: entry.branchName,
    });
    vi.mocked(worktrees.teardown).mockResolvedValue(emptyTeardownResult());
  });

  it("passes --session-id and records it without Remote Control by default", async () => {
    await launch({ remoteControlEnabled: false, agent: "claude" });

    const claudeSessionId = recordedRunningState()?.claudeSessionId;
    expect(claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordedRunningState()?.remoteControlName).toBeUndefined();
    expect(launchedScript()).toContain(`--session-id ${claudeSessionId}`);
    expect(launchedScript()).not.toContain("--remote-control");
  });

  it("puts --remote-control and -n before the prompt when enabled", async () => {
    await launch({ remoteControlEnabled: true, agent: "claude" });

    const claudeSessionId = recordedRunningState()?.claudeSessionId;
    const script = launchedScript();
    expect(recordedRunningState()?.remoteControlName).toBe("TEAM-1 repo-a");
    expect(script).toContain(
      `--session-id ${claudeSessionId} --remote-control 'TEAM-1 repo-a' -n 'TEAM-1 repo-a' "$_p"`,
    );
  });

  it("never pins a session for non-Claude agents", async () => {
    await launch({ remoteControlEnabled: true, agent: "codex" });

    expect(recordedRunningState()?.claudeSessionId).toBeUndefined();
    expect(launchedScript()).not.toContain("--session-id");
    expect(launchedScript()).not.toContain("--remote-control");
  });

  it("clears leftover cloud and session fields on the provisioning row", async () => {
    await launch({ remoteControlEnabled: false, agent: "claude" });

    const provisioning = vi
      .mocked(recordRunState)
      .mock.calls.map(([input]) => input.state)
      .find((state) => state.state === "provisioning");
    expect(provisioning?.clearFields).toStrictEqual([
      ...CLOUD_RUN_STATE_FIELDS,
      ...LOCAL_CLAUDE_SESSION_STATE_FIELDS,
    ]);
  });
});
