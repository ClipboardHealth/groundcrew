import { describe, expect, it } from "vitest";

import {
  composeLaunchCommand,
  composeResumeCommand,
  CREW_DONE_INSTRUCTION,
  defaultInitialPrompt,
  ProfileError,
  resolveProfile,
} from "./profiles.js";

describe("resolveProfile presets", () => {
  it("maps claude model and effort to real CLI flags with a --continue resume", () => {
    const resolved = resolveProfile({ name: "claude", profile: { model: "opus", effort: "high" } });

    expect(resolved.commandTemplate).toBe("claude --permission-mode auto --model 'opus' --effort 'high' {{prompt}}");
    expect(resolved.resumeTemplate).toBe("claude --permission-mode auto --model 'opus' --effort 'high' --continue");
  });

  it("omits claude model/effort flags when unset", () => {
    const resolved = resolveProfile({ name: "claude", profile: {} });

    expect(resolved.commandTemplate).toBe("claude --permission-mode auto {{prompt}}");
  });

  it("maps codex effort to a reasoning-effort config override and resume --last", () => {
    const resolved = resolveProfile({ name: "codex", profile: { model: "gpt-5", effort: "high" } });

    expect(resolved.commandTemplate).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --model 'gpt-5' -c 'model_reasoning_effort=high' {{prompt}}",
    );
    expect(resolved.resumeTemplate).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --model 'gpt-5' -c 'model_reasoning_effort=high' resume --last",
    );
  });

  it("defaults the cursor model and trails the boolean flags", () => {
    const resolved = resolveProfile({ name: "cursor", profile: {} });

    expect(resolved.commandTemplate).toBe(
      "cursor-agent --model 'composer-2.5' --sandbox disabled --force --approve-mcps {{prompt}}",
    );
    expect(resolved.resumeTemplate).toBe(
      "cursor-agent --model 'composer-2.5' --sandbox disabled --force --approve-mcps --continue",
    );
  });

  it("exposes no captured session id for presets (honest seam)", () => {
    const resolved = resolveProfile({ name: "claude", profile: {} });

    expect(resolved.captureSessionId({ output: "session abc123" })).toBeUndefined();
  });
});

describe("resolveProfile custom profiles", () => {
  it("uses the command and resume templates verbatim", () => {
    const resolved = resolveProfile({
      name: "scripted",
      profile: {
        command: "scripted-agent {{prompt}}",
        resume: "scripted-agent --resume {{sessionId}}",
        environment: { MY_AGENT_VAR: "value" },
      },
    });

    expect(resolved.commandTemplate).toBe("scripted-agent {{prompt}}");
    expect(resolved.resumeTemplate).toBe("scripted-agent --resume {{sessionId}}");
    expect(resolved.environment).toEqual({ MY_AGENT_VAR: "value" });
  });

  it("treats a preset name carrying its own command as custom", () => {
    const resolved = resolveProfile({ name: "claude", profile: { command: "my-claude {{prompt}}" } });

    expect(resolved.commandTemplate).toBe("my-claude {{prompt}}");
    expect(resolved.resumeTemplate).toBeUndefined();
  });

  it("rejects a non-preset name without a command", () => {
    expect(() => resolveProfile({ name: "mystery", profile: {} })).toThrow(ProfileError);
  });
});

describe("composeLaunchCommand", () => {
  it("shell-quotes the prompt into the template", () => {
    const resolved = resolveProfile({ name: "scripted", profile: { command: "scripted-agent {{prompt}}" } });

    expect(composeLaunchCommand({ profile: resolved, prompt: "do the thing" })).toBe(
      "scripted-agent 'do the thing'",
    );
  });

  it("escapes single quotes in the prompt", () => {
    const resolved = resolveProfile({ name: "scripted", profile: { command: "scripted-agent {{prompt}}" } });

    expect(composeLaunchCommand({ profile: resolved, prompt: "don't stop" })).toBe(
      String.raw`scripted-agent 'don'\''t stop'`,
    );
  });

  it("preserves multiple spaces inside the quoted prompt", () => {
    const resolved = resolveProfile({ name: "scripted", profile: { command: "scripted-agent {{prompt}}" } });

    expect(composeLaunchCommand({ profile: resolved, prompt: "a  b" })).toBe("scripted-agent 'a  b'");
  });

  it("substitutes {{model}} in a custom template", () => {
    const resolved = resolveProfile({
      name: "scripted",
      profile: { command: "run --model {{model}} -- {{prompt}}", model: "m1" },
    });

    expect(composeLaunchCommand({ profile: resolved, prompt: "go" })).toBe("run --model 'm1' -- 'go'");
  });
});

describe("composeResumeCommand", () => {
  it("substitutes a captured session id", () => {
    const resolved = resolveProfile({
      name: "scripted",
      profile: { command: "scripted-agent {{prompt}}", resume: "scripted-agent --resume {{sessionId}}" },
    });

    expect(composeResumeCommand({ profile: resolved, sessionId: "abc123" })).toBe(
      "scripted-agent --resume 'abc123'",
    );
  });

  it("blanks {{sessionId}} when no id is captured", () => {
    const resolved = resolveProfile({
      name: "scripted",
      profile: { command: "scripted-agent {{prompt}}", resume: "scripted-agent --resume {{sessionId}}" },
    });

    expect(composeResumeCommand({ profile: resolved })).toBe("scripted-agent --resume");
  });

  it("ignores the captured id under --fresh", () => {
    const resolved = resolveProfile({
      name: "scripted",
      profile: {
        command: "scripted-agent {{prompt}}",
        resume: "scripted-agent --resume {{sessionId}}",
        fresh: true,
      },
    });

    expect(composeResumeCommand({ profile: resolved, sessionId: "abc123" })).toBe(
      "scripted-agent --resume",
    );
  });

  it("returns undefined for a custom profile with no resume form", () => {
    const resolved = resolveProfile({ name: "scripted", profile: { command: "scripted-agent {{prompt}}" } });

    expect(composeResumeCommand({ profile: resolved, sessionId: "abc123" })).toBeUndefined();
  });

  it("uses the preset built-in resume form (cwd/latest, no id needed)", () => {
    const resolved = resolveProfile({ name: "claude", profile: {} });

    expect(composeResumeCommand({ profile: resolved })).toBe("claude --permission-mode auto --continue");
  });
});

describe("defaultInitialPrompt", () => {
  it("closes with the crew done instruction when given task prose", () => {
    const prompt = defaultInitialPrompt({ task: "Fix the bug" });

    expect(prompt.startsWith("Fix the bug")).toBe(true);
    expect(prompt.endsWith(CREW_DONE_INSTRUCTION)).toBe(true);
  });

  it("is just the instruction when no task prose is given", () => {
    expect(defaultInitialPrompt()).toBe(CREW_DONE_INSTRUCTION);
  });
});
