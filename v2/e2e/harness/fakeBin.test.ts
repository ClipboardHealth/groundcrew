import path from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "./exec.js";
import { makeFailingShim, makeRecordingShim, readCallLog, readGhCalls } from "./fakeBin.js";
import { withScenario } from "./scenario.js";

describe("fakeBin", () => {
  it("records fake gh invocations resolved first on PATH", async () => {
    await withScenario(async (scenario) => {
      const result = await run({
        command: "gh",
        args: ["pr", "create", "--title", "x"],
        env: scenario.env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");

      const calls = readGhCalls({ scenario });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.argv).toEqual(["pr", "create", "--title", "x"]);
    });
  });

  it("makeFailingShim shadows a binary with a nonzero exit", async () => {
    await withScenario(async (scenario) => {
      makeFailingShim({ scenario, name: "tmux", exitCode: 7, message: "tmux down" });

      const result = await run({ command: "tmux", args: ["-V"], env: scenario.env });
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("tmux down");
    });
  });

  it("makeRecordingShim records invocations", async () => {
    await withScenario(async (scenario) => {
      const logPath = path.join(scenario.root, "crew-calls.jsonl");
      makeRecordingShim({ scenario, name: "crew-rec", logPath });

      await run({ command: "crew-rec", args: ["done", "--outcome", "delivered"], env: scenario.env });

      const calls = readCallLog(logPath);
      expect(calls[0]?.argv).toEqual(["done", "--outcome", "delivered"]);
    });
  });
});
