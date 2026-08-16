import { readFileSync } from "node:fs";

import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, type RunState, updateRunState } from "../lib/runState.ts";
import { recordUsageCli } from "./recordUsage.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof readFileSync>() };
});
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    updateRunState: vi.fn<typeof updateRunState>(),
  };
});

const readFileSyncMock = vi.mocked(readFileSync);
const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const updateRunStateMock = vi.mocked(updateRunState);

const config = { logging: { file: "/tmp/groundcrew.log" } } as ResolvedConfig;

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    task: "ENG-1",
    repository: "repo-a",
    agent: "claude",
    worktreeDir: "/work/repo-a-eng-1",
    branchName: "dev-eng-1",
    workspaceName: "eng-1",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resumeCount: 0,
    ...overrides,
  };
}

function assistantLine(id: string, outputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    message: { id, role: "assistant", usage: { output_tokens: outputTokens } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadConfigMock.mockResolvedValue(config);
  readRunStateMock.mockReturnValue(runState());
});

describe(recordUsageCli, () => {
  it.each([[[]], [["--task"]], [["--task", ""]]])(
    "rejects a missing task rather than silently recording nothing (%j)",
    async (argv) => {
      await expect(recordUsageCli(argv)).rejects.toThrow("Usage: crew record-usage");
    },
  );

  it("records the session against the task", async () => {
    readFileSyncMock.mockReturnValue([assistantLine("m1", 10), assistantLine("m2", 5)].join("\n"));

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/session.jsonl"]);

    expect(updateRunStateMock).toHaveBeenCalledWith({
      config,
      task: "ENG-1",
      patch: {
        state: "running",
        usage: {
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 15,
          messages: 2,
        },
      },
    });
  });

  it("folds a resumed session into the counts already recorded", async () => {
    readRunStateMock.mockReturnValue(
      runState({
        usage: {
          inputTokens: 1,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          outputTokens: 4,
          messages: 1,
        },
      }),
    );
    readFileSyncMock.mockReturnValue(assistantLine("m9", 6));

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/session.jsonl"]);

    expect(updateRunStateMock.mock.calls[0]?.[0].patch.usage).toStrictEqual({
      inputTokens: 1,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      outputTokens: 10,
      messages: 2,
    });
  });

  it("preserves the lifecycle state rather than moving the task", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "resumed" }));
    readFileSyncMock.mockReturnValue(assistantLine("m1", 1));

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/session.jsonl"]);

    expect(updateRunStateMock.mock.calls[0]?.[0].patch.state).toBe("resumed");
  });

  it("reads the transcript path from the hook payload on stdin", async () => {
    readFileSyncMock
      .mockReturnValueOnce(JSON.stringify({ transcript_path: "/tmp/from-stdin.jsonl" }))
      .mockReturnValueOnce(assistantLine("m1", 3));

    await recordUsageCli(["--task", "ENG-1"]);

    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/from-stdin.jsonl", "utf8");
    expect(updateRunStateMock).toHaveBeenCalled();
  });

  it("prefers an explicit transcript over the stdin payload", async () => {
    readFileSyncMock.mockReturnValue(assistantLine("m1", 1));

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/explicit.jsonl"]);

    // stdin is never read when the path is already known.
    expect(readFileSyncMock).not.toHaveBeenCalledWith(0, "utf8");
  });

  it("does nothing when stdin carries no usable payload", async () => {
    readFileSyncMock.mockReturnValue("not a hook payload");

    await recordUsageCli(["--task", "ENG-1"]);

    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("does nothing when stdin cannot be read at all", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });

    await recordUsageCli(["--task", "ENG-1"]);

    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("does nothing when the transcript is gone", async () => {
    // A transcript can be rotated or cleaned up before the hook runs.
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/missing.jsonl"]);

    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("does not write an empty total when the transcript has no usage", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    );

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/session.jsonl"]);

    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("does nothing when the session outlives its run state", async () => {
    // Not worth failing a hook over: there is nothing left to attribute to.
    readRunStateMock.mockReset();
    readFileSyncMock.mockReturnValue(assistantLine("m1", 1));

    await recordUsageCli(["--task", "ENG-1", "--transcript", "/tmp/session.jsonl"]);

    expect(updateRunStateMock).not.toHaveBeenCalled();
  });
});
