import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentConfigRelocation, stageRelocatedAgentConfigHome } from "./codexConfigRelocation.ts";

function assertDefined<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) {
    throw new TypeError(`Expected ${label} to be defined`);
  }
  return value;
}

describe(agentConfigRelocation, () => {
  it("relocates codex to CODEX_HOME, seeding its file creds + config", () => {
    const actual = agentConfigRelocation("codex");

    expect(actual).toStrictEqual({
      configDirEnv: "CODEX_HOME",
      sourceHomeRelativeDir: ".codex",
      seedFiles: ["auth.json", "config.toml"],
    });
  });

  it("is case-insensitive on the agent name", () => {
    expect(agentConfigRelocation("CODEX")?.configDirEnv).toBe("CODEX_HOME");
  });

  it("returns undefined for read-only agents (claude) and unknown agents", () => {
    expect(agentConfigRelocation("claude")).toBeUndefined();
    expect(agentConfigRelocation("mystery")).toBeUndefined();
  });
});

describe(stageRelocatedAgentConfigHome, () => {
  let parentDir: string;
  let fakeHome: string;

  beforeEach(() => {
    parentDir = mkdtempSync(path.join(os.tmpdir(), "stage-relocated-parent-"));
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "stage-relocated-home-"));
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("is a no-op and returns undefined for an agent with no registered config relocation (claude)", () => {
    const result = stageRelocatedAgentConfigHome({ agent: "claude", parentDir, homeDir: fakeHome });

    expect(result).toBeUndefined();
  });

  it("stages and seeds a writable config home for a relocating agent (codex), exposing its configDirEnv", () => {
    const realCodex = path.join(fakeHome, ".codex");
    mkdirSync(realCodex, { recursive: true });
    writeFileSync(path.join(realCodex, "auth.json"), '{"token":"x"}');
    writeFileSync(path.join(realCodex, "config.toml"), "model = 'gpt'\n");

    const result = assertDefined(
      stageRelocatedAgentConfigHome({ agent: "codex", parentDir, homeDir: fakeHome }),
      "staged config home for codex",
    );
    const expectedDir = path.join(parentDir, "codex-home");
    expect(result).toStrictEqual({
      configDir: expectedDir,
      configDirEnv: { name: "CODEX_HOME", value: expectedDir },
    });
    expect(readFileSync(path.join(result.configDir, "auth.json"), "utf8")).toBe('{"token":"x"}');
    expect(readFileSync(path.join(result.configDir, "config.toml"), "utf8")).toBe(
      "model = 'gpt'\n",
    );
  });

  it("seeds only existing files, skipping a missing seed file (not-logged-in agent)", () => {
    const realCodex = path.join(fakeHome, ".codex");
    mkdirSync(realCodex, { recursive: true });
    writeFileSync(path.join(realCodex, "config.toml"), "model = 'gpt'\n");

    const result = assertDefined(
      stageRelocatedAgentConfigHome({ agent: "codex", parentDir, homeDir: fakeHome }),
      "staged config home for codex",
    );
    expect(readFileSync(path.join(result.configDir, "config.toml"), "utf8")).toBe(
      "model = 'gpt'\n",
    );
    expect(existsSync(path.join(result.configDir, "auth.json"))).toBe(false);
  });
});
