import { describe, expect, it, vi } from "vitest";

import { seedWorkspaceTrust } from "./workspaceTrust.js";

const hoisted = vi.hoisted(() => ({
  agentTrustDir: vi.fn<(input: { agent: string; dirPath: string; trustMethod: string }) => { ok: boolean; error?: string }>(),
}));

vi.mock("agent-trust", () => ({
  agentTrustDir: hoisted.agentTrustDir,
  isAgentTrustAgent: (agent: string): boolean => agent === "claude" || agent === "codex",
}));

describe("seedWorkspaceTrust", () => {
  it("seeds trust for a recognized agent under the workspace directory", () => {
    hoisted.agentTrustDir.mockReturnValue({ ok: true });
    const warn = vi.fn<(message: string) => void>();

    seedWorkspaceTrust({
      agentCommand: "claude --permission-mode auto 'do the task'",
      workspaceDirectory: "/work/task",
      warn,
    });

    expect(hoisted.agentTrustDir).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "claude", dirPath: "/work/task" }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("no-ops for an agent agent-trust does not recognize (custom cmd)", () => {
    hoisted.agentTrustDir.mockClear();
    const warn = vi.fn<(message: string) => void>();

    seedWorkspaceTrust({
      agentCommand: "my-custom-agent --go",
      workspaceDirectory: "/work/task",
      warn,
    });

    expect(hoisted.agentTrustDir).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails open: a trust-store error warns and returns rather than throwing", () => {
    hoisted.agentTrustDir.mockReturnValue({ ok: false, error: "trust store unwritable" });
    const warn = vi.fn<(message: string) => void>();

    expect(() => {
      seedWorkspaceTrust({
        agentCommand: "codex exec 'go'",
        workspaceDirectory: "/work/task",
        warn,
      });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("trust store unwritable"));
  });

  it("fails open when agent-trust throws", () => {
    hoisted.agentTrustDir.mockImplementation(() => {
      throw new Error("boom");
    });
    const warn = vi.fn<(message: string) => void>();

    expect(() => {
      seedWorkspaceTrust({ agentCommand: "claude 'go'", workspaceDirectory: "/w", warn });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
