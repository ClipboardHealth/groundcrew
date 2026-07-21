import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
      persistedFiles: ["auth.json"],
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

  it("stages and seeds a writable config home for a relocating agent (codex), exposing its configDirEnv", () => {
    const realCodex = path.join(fakeHome, ".codex");
    mkdirSync(realCodex, { recursive: true });
    writeFileSync(path.join(realCodex, "auth.json"), '{"token":"x"}');
    writeFileSync(path.join(realCodex, "config.toml"), "model = 'gpt'\n");

    const result = stageRelocatedAgentConfigHome({
      agent: "codex",
      relocation: assertDefined(agentConfigRelocation("codex"), "codex relocation"),
      parentDir,
      sourceConfigDir: realCodex,
    });
    const expectedDir = path.join(parentDir, "codex-home");
    expect(result).toStrictEqual({
      configDir: expectedDir,
      configDirEnv: { name: "CODEX_HOME", value: expectedDir },
      writeBackFiles: [
        {
          baselinePath: path.join(parentDir, "write-back-baseline", "auth.json"),
          sourcePath: realpathSync(path.join(realCodex, "auth.json")),
          stagedPath: path.join(expectedDir, "auth.json"),
        },
      ],
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

    const result = stageRelocatedAgentConfigHome({
      agent: "codex",
      relocation: assertDefined(agentConfigRelocation("codex"), "codex relocation"),
      parentDir,
      sourceConfigDir: realCodex,
    });
    expect(readFileSync(path.join(result.configDir, "config.toml"), "utf8")).toBe(
      "model = 'gpt'\n",
    );
    expect(existsSync(path.join(result.configDir, "auth.json"))).toBe(false);
    expect(result.writeBackFiles).toStrictEqual([]);
  });

  it("returns cross-filesystem-safe copy-back metadata for refreshed credentials", () => {
    const realCodex = path.join(fakeHome, ".codex");
    mkdirSync(realCodex, { recursive: true });
    const sourceAuthFile = path.join(realCodex, "auth.json");
    writeFileSync(sourceAuthFile, '{"token":"before"}');

    const result = stageRelocatedAgentConfigHome({
      agent: "codex",
      relocation: assertDefined(agentConfigRelocation("codex"), "codex relocation"),
      parentDir,
      sourceConfigDir: realCodex,
    });
    writeFileSync(path.join(result.configDir, "auth.json"), '{"token":"refreshed"}');

    expect(readFileSync(sourceAuthFile, "utf8")).toBe('{"token":"before"}');
    expect(result.writeBackFiles).toStrictEqual([
      {
        baselinePath: path.join(parentDir, "write-back-baseline", "auth.json"),
        sourcePath: realpathSync(sourceAuthFile),
        stagedPath: path.join(result.configDir, "auth.json"),
      },
    ]);
    const writeBack = assertDefined(result.writeBackFiles[0], "auth write-back");
    expect(readFileSync(writeBack.baselinePath, "utf8")).toBe('{"token":"before"}');
  });
});
