import {
  buildCmuxAgentHookSettings,
  type CmuxAgentHookSettings,
  cmuxAgentHookSettingsJson,
} from "./cmuxAgentHooks.ts";

function commandFor(settings: CmuxAgentHookSettings, event: string): string {
  const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
  if (command === undefined) {
    throw new Error(`No hook command for event ${event}`);
  }

  return command;
}

function commandsFor(settings: CmuxAgentHookSettings, event: string): string[] {
  const hooks = settings.hooks[event]?.[0]?.hooks;
  if (hooks === undefined) {
    throw new Error(`No hook commands for event ${event}`);
  }

  return hooks.map((hook) => hook.command);
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

  it("records token usage on SessionEnd, after the progress hook", () => {
    const actual = commandsFor(buildCmuxAgentHookSettings({ agent: "claude" }), "SessionEnd");

    expect(actual).toHaveLength(2);
    expect(actual[0]).toContain("set-progress");
    expect(actual[1]).toContain("groundcrew record-usage");
  });

  it("adds the usage hook only to SessionEnd, so a session is counted once", () => {
    const settings = buildCmuxAgentHookSettings({ agent: "claude" });

    for (const event of ["SessionStart", "UserPromptSubmit", "Notification", "Stop"]) {
      expect(commandsFor(settings, event)).toHaveLength(1);
    }
  });

  it("guards the usage hook on the task id and keeps it best-effort", () => {
    const actual = commandsFor(buildCmuxAgentHookSettings({ agent: "claude" }), "SessionEnd")[1];

    expect(actual).toContain('if [ -n "$GROUNDCREW_TASK_ID" ]');
    expect(actual).toContain('--task "$GROUNDCREW_TASK_ID"');
    expect(actual).toContain("|| true");
  });
});

describe(cmuxAgentHookSettingsJson, () => {
  it("serializes to valid JSON that round-trips to the settings object", () => {
    const expected = buildCmuxAgentHookSettings({ agent: "claude" });

    const actual: unknown = JSON.parse(cmuxAgentHookSettingsJson({ agent: "claude" }));

    expect(actual).toStrictEqual(expected);
  });
});
