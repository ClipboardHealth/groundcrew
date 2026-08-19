import type { ResolvedConfig } from "./config.ts";
import { failIfWorkspaceAlreadyLive } from "./workspaceLiveness.ts";
import { workspaces } from "./workspaces.ts";

vi.mock(import("./workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
      probe: vi.fn<typeof actual.workspaces.probe>(),
    },
  };
});

const probeMock = vi.mocked(workspaces.probe);
const config = {} as ResolvedConfig;

describe(failIfWorkspaceAlreadyLive, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("allows an absent workspace", async () => {
    probeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await expect(failIfWorkspaceAlreadyLive(config, "team-1", "opening")).resolves.toBeUndefined();
  });

  it("rejects a live workspace", async () => {
    probeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await expect(failIfWorkspaceAlreadyLive(config, "team-1", "resuming")).rejects.toThrow(
      /already live.*resuming/,
    );
  });

  it("rejects an unavailable workspace probe with its diagnostic", async () => {
    probeMock.mockResolvedValue({ kind: "unavailable", error: new Error("backend down") });

    await expect(failIfWorkspaceAlreadyLive(config, "team-1", "opening")).rejects.toThrow(
      /already live: backend down.*opening/,
    );
  });

  it("rejects an unavailable workspace probe without inventing a diagnostic", async () => {
    probeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(failIfWorkspaceAlreadyLive(config, "team-1", "opening")).rejects.toThrow(
      /already live\. Retry/,
    );
  });
});
