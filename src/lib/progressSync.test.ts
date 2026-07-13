import type { ResolvedConfig } from "./config.ts";
import { logEvent } from "./util.ts";
import type * as utilModule from "./util.ts";
import { syncWorkspaceProgress } from "./progressSync.ts";
import type { workspaces } from "./workspaces.ts";

const reportProgressMock = vi.hoisted(() => vi.fn<typeof workspaces.reportProgress>());

vi.mock(import("./workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: { ...actual.workspaces, reportProgress: reportProgressMock },
  };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return { ...actual, logEvent: vi.fn<typeof actual.logEvent>() };
});

const logEventMock = vi.mocked(logEvent);

function makeConfig(): ResolvedConfig {
  return { logging: { file: "/tmp/groundcrew-test.log" } } as unknown as ResolvedConfig;
}

describe("syncWorkspaceProgress (cmux bridge)", () => {
  beforeEach(() => {
    reportProgressMock.mockResolvedValue();
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("paints the workspace with a lifecycle label and logs the synced outcome", async () => {
    const config = makeConfig();

    await syncWorkspaceProgress({
      config,
      run: { task: "team-1", workspaceName: "TEAM-1", agent: "claude", state: "running" },
    });

    expect(reportProgressMock).toHaveBeenCalledWith(
      config,
      "TEAM-1",
      { value: 0.5, label: "running · claude" },
      undefined,
    );
    expect(logEventMock).toHaveBeenCalledWith("cmux-progress-sync", {
      outcome: "synced",
      task: "team-1",
      workspace: "TEAM-1",
      state: "running",
    });
  });

  it("uses the resumed label for a resumed run", async () => {
    await syncWorkspaceProgress({
      config: makeConfig(),
      run: { task: "team-2", workspaceName: "TEAM-2", agent: "codex", state: "resumed" },
    });

    expect(reportProgressMock).toHaveBeenCalledWith(
      expect.anything(),
      "TEAM-2",
      { value: 0.5, label: "resumed · codex" },
      undefined,
    );
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();

    await syncWorkspaceProgress({
      config: makeConfig(),
      run: { task: "team-3", workspaceName: "TEAM-3", agent: "claude", state: "running" },
      signal: controller.signal,
    });

    expect(reportProgressMock).toHaveBeenCalledWith(
      expect.anything(),
      "TEAM-3",
      expect.anything(),
      controller.signal,
    );
  });

  it("swallows reporting failures and logs an error outcome", async () => {
    reportProgressMock.mockRejectedValueOnce(new Error("cmux down"));

    await expect(
      syncWorkspaceProgress({
        config: makeConfig(),
        run: { task: "team-4", workspaceName: "TEAM-4", agent: "claude", state: "running" },
      }),
    ).resolves.toBeUndefined();

    expect(logEventMock).toHaveBeenCalledWith("cmux-progress-sync", {
      outcome: "error",
      task: "team-4",
      workspace: "TEAM-4",
      state: "running",
      error: "cmux down",
    });
  });
});
