import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import {
  remoteControlName,
  withClaudeSessionFlags,
  claudeRunStateFields,
  isClaudeLocalDefinition,
  newClaudeSessionId,
  planClaudeLaunch,
  type ClaudeSessionFlags,
} from "./claudeSession.ts";
import type { AgentDefinition } from "./config.ts";
import { buildLaunchCommand } from "./launchCommand.ts";
import { logEvent } from "./util.ts";

vi.mock(import("./util.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  logEvent: vi.fn(),
}));

const sessionId = "6f1f5f0e-9d0e-4d9a-8e57-0a5d3b0f6a11";
const claude: AgentDefinition = { cmd: "claude --permission-mode auto", color: "#C15F3C" };

function flags(overrides: Partial<ClaudeSessionFlags> = {}): ClaudeSessionFlags {
  return { sessionId, mode: "new", ...overrides };
}

describe("remoteControlName", () => {
  it("joins the upper-cased Linear id and the repository short name", () => {
    expect(remoteControlName({ task: "tg-1234", repository: "shift-reviews-service" })).toBe(
      "TG-1234 shift-reviews-service",
    );
  });

  it("keeps non-Linear task ids as given", () => {
    expect(remoteControlName({ task: "notion:abc", repository: "repo" })).toBe("notion:abc repo");
  });

  it("drops non-ASCII and control characters", () => {
    expect(remoteControlName({ task: "TG-1", repository: "répo\u0007-é" })).toBe("TG-1 rpo-");
  });
});

describe("withClaudeSessionFlags", () => {
  it("adds --session-id for a new launch", () => {
    expect(withClaudeSessionFlags(claude, flags()).cmd).toBe(
      `claude --permission-mode auto --session-id ${sessionId}`,
    );
  });

  it("adds --resume for a resumed launch", () => {
    expect(withClaudeSessionFlags(claude, flags({ mode: "resume" })).cmd).toBe(
      `claude --permission-mode auto --resume ${sessionId}`,
    );
  });

  it("adds a quoted Remote Control name and -n when given", () => {
    expect(withClaudeSessionFlags(claude, flags({ remoteControlName: "TG-1 it's" })).cmd).toBe(
      `claude --permission-mode auto --session-id ${sessionId} --remote-control 'TG-1 it'\\''s' -n 'TG-1 it'\\''s'`,
    );
  });

  it("preserves the other definition fields", () => {
    expect(withClaudeSessionFlags(claude, flags()).color).toBe("#C15F3C");
  });
});

describe("composed launch command", () => {
  const name = "TG-1234 shift-reviews-service";
  const definition = withClaudeSessionFlags(claude, flags({ remoteControlName: name }));

  it("keeps the session and Remote Control flags before the trailing prompt on the none runner", () => {
    const command = buildLaunchCommand({
      definition,
      promptFile: "/tmp/p/prompt.md",
      worktreeDir: "/tmp/wt",
      workingDir: "/tmp/wt",
      runner: "none",
      networkEgress: "open",
      safehouse: makeLocalConfig().safehouse,
    });

    expect(command).toContain(
      `exec claude --permission-mode auto --session-id ${sessionId} --remote-control '${name}' -n '${name}' "$_p"`,
    );
  });

  it("keeps the flags before the prompt and quoted through the safehouse layer", () => {
    const command = buildLaunchCommand({
      definition,
      promptFile: "/tmp/p/prompt.md",
      worktreeDir: "/tmp/wt",
      workingDir: "/tmp/wt",
      runner: "safehouse",
      networkEgress: "open",
      safehouse: makeLocalConfig().safehouse,
    });

    const quotedAgentCommand = `'exec claude --permission-mode auto --session-id ${sessionId} --remote-control '\\''${name}'\\'' -n '\\''${name}'\\'' "$@"'`;
    expect(command).toContain(`-c ${quotedAgentCommand} sh "$_p"`);
  });
});

describe("session identity helpers", () => {
  it("generates distinct UUIDs", () => {
    expect(newClaudeSessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newClaudeSessionId()).not.toBe(newClaudeSessionId());
  });

  it("recognizes only Claude definitions", () => {
    expect(isClaudeLocalDefinition(claude)).toBe(true);
    expect(isClaudeLocalDefinition({ cmd: "codex", color: "#000000" })).toBe(false);
  });
});

describe(planClaudeLaunch, () => {
  const base = {
    task: "tg-9",
    repository: "svc",
    remoteControlEnabled: false,
    mode: "new",
  } as const;

  beforeEach(() => {
    vi.mocked(logEvent).mockClear();
  });

  it("pins a fresh session id without Remote Control by default", () => {
    const plan = planClaudeLaunch({ ...base, definition: claude });

    expect(plan.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.remoteControlName).toBeUndefined();
    expect(plan.definition.cmd).toBe(`${claude.cmd} --session-id ${plan.claudeSessionId}`);
    expect(logEvent).toHaveBeenCalledWith("claude_session_launch", {
      flow: "claude-session-launch",
      task: "tg-9",
      mode: "new",
      outcome: "pinned",
      claudeSessionId: plan.claudeSessionId,
      remoteControl: false,
    });
  });

  it("adds the Remote Control name when enabled", () => {
    const plan = planClaudeLaunch({ ...base, definition: claude, remoteControlEnabled: true });

    expect(plan.remoteControlName).toBe("TG-9 svc");
    expect(plan.definition.cmd).toContain(`--remote-control 'TG-9 svc' -n 'TG-9 svc'`);
  });

  it("resumes the recorded session id", () => {
    const plan = planClaudeLaunch({ ...base, definition: claude, mode: "resume", sessionId });

    expect(plan.claudeSessionId).toBe(sessionId);
    expect(plan.definition.cmd).toBe(`${claude.cmd} --resume ${sessionId}`);
  });

  it("leaves non-Claude agents untouched", () => {
    const codex = { cmd: "codex", color: "#000000" };

    expect(planClaudeLaunch({ ...base, definition: codex })).toStrictEqual({ definition: codex });
    expect(logEvent).toHaveBeenCalledWith(
      "claude_session_launch",
      expect.objectContaining({ outcome: "skipped", decision: "not_claude" }),
    );
  });

  it("skips a resume with no recorded session id", () => {
    expect(planClaudeLaunch({ ...base, definition: claude, mode: "resume" })).toStrictEqual({
      definition: claude,
    });
    expect(logEvent).toHaveBeenCalledWith(
      "claude_session_launch",
      expect.objectContaining({ outcome: "skipped", decision: "no_session_id" }),
    );
  });
});

describe(claudeRunStateFields, () => {
  it("keeps only the recorded fields", () => {
    expect(
      claudeRunStateFields({
        definition: claude,
        claudeSessionId: sessionId,
        remoteControlName: "n",
      }),
    ).toStrictEqual({ claudeSessionId: sessionId, remoteControlName: "n" });
    expect(claudeRunStateFields({ definition: claude, claudeSessionId: sessionId })).toStrictEqual({
      claudeSessionId: sessionId,
    });
    expect(claudeRunStateFields({ definition: claude })).toStrictEqual({});
    expect(claudeRunStateFields(undefined)).toStrictEqual({});
  });
});
