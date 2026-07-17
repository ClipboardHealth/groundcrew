import { describe, expect, it } from "vitest";

import { run } from "./exec.js";
import type { Scenario } from "./scenario.js";
import { withScenario } from "./scenario.js";
import {
  listSessionNames,
  sessionExists,
  waitForSession,
  waitForSessionGone,
} from "./tmuxObservation.js";

async function newSession(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly command: string;
}): Promise<void> {
  await run({
    command: "tmux",
    args: [
      "-L",
      input.scenario.tmuxSocket,
      "new-session",
      "-d",
      "-s",
      input.name,
      input.command,
    ],
    env: input.scenario.env,
  });
}

describe("tmuxObservation", () => {
  it("detects a live session on the isolated socket", async () => {
    await withScenario(async (scenario) => {
      await newSession({ scenario, name: "live", command: "sleep 300" });
      await waitForSession({ scenario, name: "live" });

      expect(await sessionExists({ scenario, name: "live" })).toBe(true);
      expect(await listSessionNames({ scenario })).toContain("live");
    });
  });

  it("detects a session that has exited", async () => {
    await withScenario(async (scenario) => {
      await newSession({ scenario, name: "ephemeral", command: "true" });
      await waitForSessionGone({ scenario, name: "ephemeral" });

      expect(await sessionExists({ scenario, name: "ephemeral" })).toBe(false);
    });
  });

  it("reports no sessions when the server is not running", async () => {
    await withScenario(async (scenario) => {
      expect(await listSessionNames({ scenario })).toEqual([]);
      expect(await sessionExists({ scenario, name: "anything" })).toBe(false);
    });
  });
});
