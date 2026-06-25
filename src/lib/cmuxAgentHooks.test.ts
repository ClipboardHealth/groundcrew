import {
  buildCmuxAgentHookSettings,
  type CmuxAgentHookSettings,
  cmuxAgentHookDelivery,
  isCmuxAgentHookCommand,
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

  it("stamps every command with the groundcrew marker so a later merge can find it", () => {
    const settings = buildCmuxAgentHookSettings({ agent: "claude" });

    for (const event of Object.keys(settings.hooks)) {
      expect(isCmuxAgentHookCommand(commandFor(settings, event))).toBe(true);
    }
  });
});

describe(isCmuxAgentHookCommand, () => {
  it("recognizes groundcrew-authored hook commands", () => {
    const command = commandFor(buildCmuxAgentHookSettings({ agent: "claude" }), "Stop");

    expect(isCmuxAgentHookCommand(command)).toBe(true);
  });

  it("does not claim an unrelated user hook command", () => {
    expect(isCmuxAgentHookCommand("npm run lint")).toBe(false);
  });
});

describe(cmuxAgentHookDelivery, () => {
  it("delivers Claude hooks via the project settings.local.json file", () => {
    expect(cmuxAgentHookDelivery("claude")).toStrictEqual({
      projectSettingsPath: ".claude/settings.local.json",
    });
  });

  it("returns no delivery for agents without a hook integration", () => {
    expect(cmuxAgentHookDelivery("codex")).toBeUndefined();
    expect(cmuxAgentHookDelivery("cursor-agent")).toBeUndefined();
  });
});
