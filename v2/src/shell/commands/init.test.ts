import { describe, expect, it } from "vitest";

import { convertV1Config } from "./init.js";

describe("convertV1Config", () => {
  const v1 = [
    "export default {",
    '  workspace: { projectDir: "/home/me/dev", knownRepositories: ["alpha"] },',
    '  agents: { default: "claude", definitions: { claude: {} } },',
    '  multiplexer: "tmux",',
    '  sources: [{ kind: "shell", name: "jira", commands: { listTasks: "x" } }],',
    '  local: { runner: "auto", safehouse: { enable: ["agent-browser"] } },',
    "} satisfies Config;",
  ].join("\n");

  it("renames projectDir to workspace.baseDirectory and extracts the value", () => {
    const converted = convertV1Config(v1);
    expect(converted.baseDirectory).toBe("/home/me/dev");
    expect(converted.notes.some((note) => note.includes("projectDir"))).toBe(true);
  });

  it("names every dropped or renamed key with why", () => {
    const joined = convertV1Config(v1).notes.join("\n");
    expect(joined).toMatch(/knownRepositories/);
    expect(joined).toMatch(/definitions/);
    expect(joined).toMatch(/multiplexer/);
    expect(joined).toMatch(/shell/);
    expect(joined).toMatch(/safehouse/);
    expect(joined).toMatch(/runner/);
  });

  it("notes when nothing recognizable was found", () => {
    expect(convertV1Config("export default {}").notes.join("")).toMatch(/no recognizable/i);
  });

  // The user's real dogfooding config (DEVOP): defaults.hooks, agent definitions
  // with pure-export preLaunch + preLaunchEnv, a linear source, knownRepositories.
  const realConfig = [
    'import type { Config } from "@clipboard-health/groundcrew";',
    "export default {",
    '  defaults: { hooks: { prepareWorktree: "test ! -f package-lock.json || npm ci" } },',
    "  agents: {",
    '    default: "claude",',
    "    definitions: {",
    '      claude: { preLaunch: "export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true", preLaunchEnv: ["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"] },',
    '      codex:  { preLaunch: "export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true", preLaunchEnv: ["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"] },',
    "    },",
    "  },",
    '  sources: [{ kind: "linear", name: "l" }],',
    "  workspace: {",
    '    projectDir: "~/dev",',
    '    knownRepositories: ["cbh-admin-frontend", "cbh-core", /* …9 repos */ "groundtruth"],',
    "  },",
    "} satisfies Config;",
  ].join("\n");

  it("passes a non-shell source through with its kind and name", () => {
    const converted = convertV1Config(realConfig);
    expect(converted.sources).toEqual([{ kind: "linear", name: "l" }]);
    expect(converted.notes.join("\n")).toContain("kept source linear");
  });

  it("maps defaults.hooks.prepareWorktree to workspace.prepareWorktree", () => {
    const converted = convertV1Config(realConfig);
    expect(converted.prepareWorktree).toBe("test ! -f package-lock.json || npm ci");
    expect(converted.notes.join("\n")).toContain("defaults.hooks.prepareWorktree");
  });

  it("renames agents.definitions to profiles as pure presets", () => {
    const converted = convertV1Config(realConfig);
    expect(converted.agents?.default).toBe("claude");
    expect(converted.agents?.profiles).toEqual({ claude: {}, codex: {} });
  });

  it("collects pure preLaunch exports into workspace.environment, deduped across profiles", () => {
    const converted = convertV1Config(realConfig);
    expect(converted.environment).toEqual({ PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true" });
    expect(converted.notes.join("\n")).toContain("collected preLaunch exports");
  });

  it("drops a shell source with a reason and never keeps it", () => {
    const converted = convertV1Config(
      'export default { sources: [{ kind: "shell", name: "jira", commands: {} }] };',
    );
    expect(converted.sources).toEqual([]);
    expect(converted.notes.join("\n")).toContain('dropped shell source "jira"');
  });

  it("treats v1 declaring no sources as undefined (keep the default)", () => {
    expect(convertV1Config('export default { workspace: { projectDir: "/d" } };').sources).toBeUndefined();
  });

  it("treats v1 declaring only a dropped source as an empty list (not a silent swap)", () => {
    expect(convertV1Config('export default { sources: [{ kind: "shell" }] };').sources).toEqual([]);
  });

  it("drops a preLaunch that is not pure exports, naming the profile", () => {
    const converted = convertV1Config(
      [
        "export default {",
        "  agents: { definitions: {",
        '    claude: { preLaunch: "npm run setup && export X=1" },',
        "  } },",
        "};",
      ].join("\n"),
    );
    expect(converted.environment).toBeUndefined();
    expect(converted.notes.join("\n")).toContain('dropped preLaunch for agent "claude"');
  });

  // The regression net: every "kept/renamed/mapped/collected" line must correspond
  // to something the converter actually produced, and every "dropped" line to
  // something absent — announcements can never diverge from output (Bug 1).
  it("keeps announcements consistent with the converted output", () => {
    const converted = convertV1Config(realConfig);
    const notes = converted.notes.join("\n");

    expect(notes).toContain("kept source linear");
    expect(converted.sources).toContainEqual({ kind: "linear", name: "l" });

    expect(notes).toContain("agents.definitions → agents.profiles");
    expect(converted.agents).toBeDefined();

    expect(notes).toContain("defaults.hooks.prepareWorktree");
    expect(converted.prepareWorktree).toBeDefined();

    expect(notes).toContain("collected preLaunch exports");
    expect(converted.environment).toBeDefined();

    // realConfig kept linear only; nothing shell survives into the output.
    expect(converted.sources?.some((source) => source.kind === "shell")).toBe(false);
  });
});
