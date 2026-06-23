import {
  agentHookDelivery,
  buildCmuxAgentHookSettings,
  buildCursorProjectHooks,
  type CmuxAgentHookSettings,
  cmuxAgentHookSettingsJson,
  cursorProjectHooksJson,
  isGroundcrewHookCommand,
} from "./cmuxAgentHooks.ts";

function commandFor(settings: CmuxAgentHookSettings, event: string): string {
  const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
  if (command === undefined) {
    throw new Error(`No hook command for event ${event}`);
  }

  return command;
}

describe(buildCmuxAgentHookSettings, () => {
  it("emits one command hook for each lifecycle event", () => {
    const actual = buildCmuxAgentHookSettings({ agent: "claude" });

    expect(Object.keys(actual.hooks)).toStrictEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Notification",
      "Stop",
      "SessionEnd",
    ]);
    for (const groups of Object.values(actual.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks[0]?.type).toBe("command");
    }
  });

  it("labels SessionStart with the agent and maps the other lifecycle phases", () => {
    const actual = buildCmuxAgentHookSettings({ agent: "claude" });

    expect(commandFor(actual, "SessionStart")).toContain("running · claude");
    expect(commandFor(actual, "UserPromptSubmit")).toContain("working");
    expect(commandFor(actual, "Notification")).toContain("idle");
    expect(commandFor(actual, "Stop")).toContain("idle");
    expect(commandFor(actual, "SessionEnd")).toContain("done");
  });

  it("guards on the workspace id and stays best-effort so a hook never breaks the agent", () => {
    const actual = commandFor(buildCmuxAgentHookSettings({ agent: "claude" }), "SessionStart");

    expect(actual).toContain('if [ -n "$CMUX_WORKSPACE_ID" ]');
    expect(actual).toContain('--workspace "$CMUX_WORKSPACE_ID"');
    expect(actual).toContain("|| true");
  });

  it("resolves the cmux CLI from the bundled path with a PATH fallback", () => {
    const actual = commandFor(buildCmuxAgentHookSettings({ agent: "claude" }), "Stop");

    // eslint-disable-next-line no-template-curly-in-string -- shell parameter expansion, not a JS template
    expect(actual).toContain('"${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress');
  });

  it("flows a non-default agent name into the running label", () => {
    const actual = commandFor(buildCmuxAgentHookSettings({ agent: "codex" }), "SessionStart");

    expect(actual).toContain("running · codex");
  });
});

describe(cmuxAgentHookSettingsJson, () => {
  it("serializes to valid JSON that round-trips to the settings object", () => {
    const expected = buildCmuxAgentHookSettings({ agent: "claude" });

    const actual: unknown = JSON.parse(cmuxAgentHookSettingsJson({ agent: "claude" }));

    expect(actual).toStrictEqual(expected);
  });
});

function cursorCommandFor(
  hooks: ReturnType<typeof buildCursorProjectHooks>,
  event: string,
): string {
  const command = hooks.hooks[event]?.[0]?.command;
  if (command === undefined) {
    throw new Error(`No cursor hook command for event ${event}`);
  }

  return command;
}

describe(buildCursorProjectHooks, () => {
  it("maps the shared progress phases onto cursor's lifecycle event names", () => {
    const actual = buildCursorProjectHooks({ agent: "cursor" });

    expect(actual.version).toBe(1);
    expect(Object.keys(actual.hooks)).toStrictEqual([
      "sessionStart",
      "beforeSubmitPrompt",
      "stop",
      "afterAgentResponse",
      "sessionEnd",
    ]);
    expect(cursorCommandFor(actual, "sessionStart")).toContain("running · cursor");
    expect(cursorCommandFor(actual, "beforeSubmitPrompt")).toContain("working");
    expect(cursorCommandFor(actual, "stop")).toContain("idle");
    expect(cursorCommandFor(actual, "afterAgentResponse")).toContain("idle");
    expect(cursorCommandFor(actual, "sessionEnd")).toContain("done");
  });

  it("paints via the same guarded best-effort set-progress command as claude", () => {
    const actual = cursorCommandFor(buildCursorProjectHooks({ agent: "cursor" }), "stop");

    expect(actual).toContain('if [ -n "$CMUX_WORKSPACE_ID" ]');
    expect(actual).toContain('--workspace "$CMUX_WORKSPACE_ID"');
    // eslint-disable-next-line no-template-curly-in-string -- shell parameter expansion, not a JS template
    expect(actual).toContain('"${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress');
    expect(actual).toContain("|| true");
  });
});

describe(cursorProjectHooksJson, () => {
  it("serializes to valid JSON that round-trips to the cursor hooks object", () => {
    const expected = buildCursorProjectHooks({ agent: "cursor" });

    const actual: unknown = JSON.parse(cursorProjectHooksJson({ agent: "cursor" }));

    expect(actual).toStrictEqual(expected);
  });
});

describe(agentHookDelivery, () => {
  it("routes claude to inline settings and cursor to a project file", () => {
    expect(agentHookDelivery("claude")).toBe("claude-settings");
    expect(agentHookDelivery("cursor")).toBe("cursor-project-file");
  });

  it("returns undefined for agents with no hook integration", () => {
    expect(agentHookDelivery("codex")).toBeUndefined();
  });
});

describe(isGroundcrewHookCommand, () => {
  it("recognizes a painted set-progress command and ignores foreign ones", () => {
    const ours = cursorCommandFor(buildCursorProjectHooks({ agent: "cursor" }), "stop");

    expect(isGroundcrewHookCommand(ours)).toBe(true);
    expect(isGroundcrewHookCommand("bun run ./hooks/repo-stop.ts")).toBe(false);
  });
});
