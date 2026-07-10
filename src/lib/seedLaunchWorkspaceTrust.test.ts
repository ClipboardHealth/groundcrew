import { agentTrustDir } from "@paulbaranowski/agent-trust";

import { seedLaunchWorkspaceTrust } from "./seedLaunchWorkspaceTrust.ts";
import { writeError } from "./util.ts";

vi.mock(import("@paulbaranowski/agent-trust"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paulbaranowski/agent-trust")>();
  return { ...actual, agentTrustDir: vi.fn<typeof agentTrustDir>() };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("./util.ts")>();
  return { ...actual, writeError: vi.fn<typeof actual.writeError>() };
});

const agentTrustDirMock = vi.mocked(agentTrustDir);
const writeErrorMock = vi.mocked(writeError);

describe(seedLaunchWorkspaceTrust, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("records trust with the groundcrew trust method", () => {
    agentTrustDirMock.mockReturnValue({
      ok: true,
      status: "trusted",
      agent: "claude",
      dirPath: "/work/repo-team-1",
    });

    seedLaunchWorkspaceTrust({
      agentCommandName: "claude",
      launchDir: "/work/repo-team-1",
    });

    expect(agentTrustDirMock).toHaveBeenCalledWith({
      agent: "claude",
      dirPath: "/work/repo-team-1",
      trustMethod: "groundcrew-auto-trust",
    });
    expect(writeErrorMock).not.toHaveBeenCalled();
  });

  it("logs and continues when trust seeding fails", () => {
    agentTrustDirMock.mockReturnValue({
      ok: false,
      status: "error",
      error: "agent-trust: could not seed Cursor workspace trust",
    });

    seedLaunchWorkspaceTrust({
      agentCommandName: "cursor-agent",
      launchDir: "/work/repo-team-1",
    });

    expect(writeErrorMock).toHaveBeenCalledWith(
      "groundcrew: agent-trust: could not seed Cursor workspace trust",
    );
  });
});
