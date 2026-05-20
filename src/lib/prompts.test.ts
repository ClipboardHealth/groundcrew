import type { ResolvedConfig } from "./config.ts";
import {
  CLAUDE_DEFAULT_PROMPT,
  CODEX_DEFAULT_PROMPT,
  DEFAULT_PROMPTS_BY_MODEL,
  GENERIC_DEFAULT_PROMPT,
  resolvePromptForModel,
} from "./prompts.ts";

function withGlobalPromptOverride(initial?: string): Pick<ResolvedConfig, "prompts"> {
  return { prompts: { initial } };
}

describe(resolvePromptForModel, () => {
  it("returns the user's global override for any model when set", () => {
    const config = withGlobalPromptOverride("custom override prompt");

    expect(resolvePromptForModel(config, "claude")).toBe("custom override prompt");
    expect(resolvePromptForModel(config, "codex")).toBe("custom override prompt");
    expect(resolvePromptForModel(config, "unknown-model")).toBe("custom override prompt");
  });

  it("returns the Claude default for the claude model when no override is set", () => {
    const resolved = resolvePromptForModel(withGlobalPromptOverride(), "claude");

    expect(resolved).toBe(CLAUDE_DEFAULT_PROMPT);
  });

  it("returns the Codex default for the codex model when no override is set", () => {
    const resolved = resolvePromptForModel(withGlobalPromptOverride(), "codex");

    expect(resolved).toBe(CODEX_DEFAULT_PROMPT);
  });

  it("returns the generic default for unknown models when no override is set", () => {
    const resolved = resolvePromptForModel(withGlobalPromptOverride(), "cursor");

    expect(resolved).toBe(GENERIC_DEFAULT_PROMPT);
  });

  it("consults DEFAULT_PROMPTS_BY_MODEL for the shipped agents", () => {
    expect(DEFAULT_PROMPTS_BY_MODEL).toStrictEqual({
      claude: CLAUDE_DEFAULT_PROMPT,
      codex: CODEX_DEFAULT_PROMPT,
    });
  });
});
