import { listCmuxWorkspaceSummaries } from "./cmuxAdapter.ts";
import type { RunCommandOptions } from "./commandRunner.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

describe(listCmuxWorkspaceSummaries, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("maps cmux's workspace list into id/taskId/title/currentDirectory summaries", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify({
        workspaces: [
          {
            title: "Work on TEAM-1",
            id: "ws-uuid-1",
            description: "groundcrew:team-1",
            current_directory: "/work/repo-a-team-1",
          },
          {
            title: "Legacy workspace",
            id: "ws-uuid-2",
            description: null,
          },
        ],
      }),
    );

    const result = await listCmuxWorkspaceSummaries();

    expect(result).toStrictEqual([
      {
        id: "ws-uuid-1",
        taskId: "team-1",
        title: "Work on TEAM-1",
        currentDirectory: "/work/repo-a-team-1",
      },
      {
        id: "ws-uuid-2",
        taskId: "Legacy workspace",
        title: "Legacy workspace",
        currentDirectory: undefined,
      },
    ]);
  });

  it("returns undefined when the underlying cmux list call fails", async () => {
    runCommandMock.mockRejectedValue(new Error("cmux not on PATH"));

    await expect(listCmuxWorkspaceSummaries()).resolves.toBeUndefined();
  });

  it("forwards the abort signal to the underlying cmux call", async () => {
    runCommandMock.mockResolvedValue(JSON.stringify({ workspaces: [] }));
    const { signal } = new AbortController();

    await listCmuxWorkspaceSummaries(signal);

    expect(runCommandMock).toHaveBeenCalledWith("cmux", ["--json", "workspace", "list"], {
      signal,
    });
  });
});
