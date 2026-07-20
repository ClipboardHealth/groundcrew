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
});
