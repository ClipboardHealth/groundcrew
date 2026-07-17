import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "./exec.js";
import { readGhCalls } from "./fakeBin.js";
import { createScenario, withScenario } from "./scenario.js";
import { sessionExists, waitForSession } from "./tmuxObservation.js";

describe("scenario", () => {
  it("owns HOME and XDG dirs inside its tmpdir and resolves fakes first on PATH", async () => {
    await withScenario(async (scenario) => {
      expect(scenario.env["HOME"]).toBe(scenario.home);
      expect(scenario.home.startsWith(scenario.root)).toBe(true);
      expect(scenario.env["XDG_CONFIG_HOME"]).toBe(scenario.configHome);
      expect(scenario.env["XDG_STATE_HOME"]).toBe(scenario.stateHome);
      expect(scenario.configHome.startsWith(scenario.root)).toBe(true);
      expect(scenario.stateHome.startsWith(scenario.root)).toBe(true);

      const pathEntries = String(scenario.env["PATH"]).split(path.delimiter);
      expect(pathEntries[0]).toBe(scenario.fakesBinDirectory);

      const result = await run({ command: "gh", args: ["api", "x"], env: scenario.env });
      expect(result.exitCode).toBe(0);
      expect(readGhCalls({ scenario })).toHaveLength(1);
    });
  });

  it("sets GROUNDCREW_TMUX_SOCKET to the scenario id", async () => {
    await withScenario(async (scenario) => {
      expect(scenario.env["GROUNDCREW_TMUX_SOCKET"]).toBe(scenario.id);
      expect(scenario.tmuxSocket).toBe(scenario.id);
    });
  });

  it("cleanup kills the tmux server and removes the tmpdir", async () => {
    const scenario = createScenario();
    await run({
      command: "tmux",
      args: ["-L", scenario.tmuxSocket, "new-session", "-d", "-s", "work", "sleep 300"],
      env: scenario.env,
    });
    await waitForSession({ scenario, name: "work" });
    expect(await sessionExists({ scenario, name: "work" })).toBe(true);

    await scenario.dispose();

    expect(fs.existsSync(scenario.root)).toBe(false);
    expect(await sessionExists({ scenario, name: "work" })).toBe(false);
  });
});
