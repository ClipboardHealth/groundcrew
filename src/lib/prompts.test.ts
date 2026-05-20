import type { ResolvedConfig } from "./config.ts";
import {
  CLAUDE_DEFAULT_PROMPT,
  CODEX_DEFAULT_PROMPT,
  DEFAULT_PROMPTS_BY_MODEL,
  GENERIC_DEFAULT_PROMPT,
  resolvePromptForModel,
} from "./prompts.ts";

// Placeholder set kept in sync with `ALLOWED_PROMPT_PLACEHOLDERS` in
// `config.ts`. Duplicated here on purpose: if the allowlist drifts, the
// shipped defaults must still satisfy it, and this duplication is what
// catches that drift. The placeholder validator lives in config because
// it validates user-supplied prompts at load time; the assertion here
// validates the *shipped* defaults statically.
const ALLOWED_PLACEHOLDERS = new Set([
  "{{ticket}}",
  "{{worktree}}",
  "{{title}}",
  "{{description}}",
]);
const PLACEHOLDER_RE = /{{[^{}]*}}/g;

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
});

describe("shipped default prompts", () => {
  const shippedPrompts: [string, string][] = [
    ["CLAUDE_DEFAULT_PROMPT", CLAUDE_DEFAULT_PROMPT],
    ["CODEX_DEFAULT_PROMPT", CODEX_DEFAULT_PROMPT],
    ["GENERIC_DEFAULT_PROMPT", GENERIC_DEFAULT_PROMPT],
  ];

  it.each(shippedPrompts)("%s uses only the allowed placeholders", (_name, prompt) => {
    const found = [...prompt.matchAll(PLACEHOLDER_RE)].map((match) => match[0]);
    const disallowed = found.filter((placeholder) => !ALLOWED_PLACEHOLDERS.has(placeholder));

    expect(disallowed).toStrictEqual([]);
  });

  it.each(shippedPrompts)("%s references every required placeholder", (_name, prompt) => {
    for (const placeholder of ALLOWED_PLACEHOLDERS) {
      expect(prompt).toContain(placeholder);
    }
  });

  it.each(shippedPrompts)("%s instructs the agent to open the PR as a draft", (_name, prompt) => {
    expect(prompt.toLowerCase()).toContain("draft");
  });

  it.each(shippedPrompts)(
    "%s instructs the agent to move the ticket to In Review",
    (_name, prompt) => {
      expect(prompt).toContain("In Review");
    },
  );

  it("CLAUDE_DEFAULT_PROMPT invokes the superpowers entry-point skill", () => {
    expect(CLAUDE_DEFAULT_PROMPT).toContain("superpowers:using-superpowers");
  });

  it("CODEX_DEFAULT_PROMPT does not reference Claude Code skills", () => {
    expect(CODEX_DEFAULT_PROMPT).not.toContain("superpowers:");
  });

  it.each(shippedPrompts)(
    "%s tells the agent to include a tmux-attach hint in the PR description",
    (_name, prompt) => {
      expect(prompt).toContain("tmux attach -t groundcrew:{{ticket}}");
    },
  );

  it("CLAUDE_DEFAULT_PROMPT instructs the agent to omit the Claude Code attribution footer", () => {
    expect(CLAUDE_DEFAULT_PROMPT).toContain("Generated with Claude Code");
    expect(CLAUDE_DEFAULT_PROMPT).toMatch(/do not append.*Generated with Claude Code/i);
  });

  it.each(shippedPrompts)(
    "%s closes the autonomy loophole with a No exceptions list",
    (_name, prompt) => {
      expect(prompt).toContain("No exceptions");
    },
  );

  it.each(shippedPrompts)(
    "%s contains the spirit-vs-letter principle on the autonomy rule",
    (_name, prompt) => {
      expect(prompt.toLowerCase()).toContain("violating the letter");
    },
  );

  it.each(shippedPrompts)(
    "%s addresses pre-existing, unrelated, and flaky test failures explicitly",
    (_name, prompt) => {
      expect(prompt).toContain("Pre-existing failures");
      expect(prompt).toContain("flaky");
    },
  );

  it.each(shippedPrompts)(
    "%s closes the false-convergence loophole on the iteration loop",
    (_name, prompt) => {
      expect(prompt).toContain("no remaining substantive findings");
      expect(prompt.toLowerCase()).toMatch(/same findings.*not.*convergence/);
    },
  );

  it("DEFAULT_PROMPTS_BY_MODEL maps the shipped agents to their prompts", () => {
    expect(DEFAULT_PROMPTS_BY_MODEL).toStrictEqual({
      claude: CLAUDE_DEFAULT_PROMPT,
      codex: CODEX_DEFAULT_PROMPT,
    });
  });
});
