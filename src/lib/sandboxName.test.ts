import { sandboxNameFor } from "./sandboxName.ts";

describe(sandboxNameFor, () => {
  it("composes `groundcrew-<agent>` in lowercase", () => {
    expect(sandboxNameFor({ agent: "Claude" })).toBe("groundcrew-claude");
  });

  it("normalizes unsafe characters to single dashes", () => {
    expect(sandboxNameFor({ agent: "my/agent_v2!" })).toBe("groundcrew-my-agent-v2");
  });

  it("collapses runs of dashes and strips leading/trailing dashes", () => {
    expect(sandboxNameFor({ agent: "--cursor--" })).toBe("groundcrew-cursor");
  });
});
