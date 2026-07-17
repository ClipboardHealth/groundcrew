import * as fs from "node:fs";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { run } from "./exec.js";
import { makeRecordingShim, readCallLog } from "./fakeBin.js";
import { commitSubjects } from "./gitFixtures.js";
import type { Scenario } from "./scenario.js";
import { withScenario } from "./scenario.js";
import {
  agentScriptsDirectory,
  heartbeatPath,
  installScriptedAgent,
  readResumeRecords,
  waitForHeartbeat,
  writeAgentScript,
} from "./scriptedAgent.js";
import type { AgentStep } from "./scriptedAgent.js";

function agentEnv(input: {
  readonly scenario: Scenario;
  readonly workspace: string;
  readonly extra?: Record<string, string>;
}): Record<string, string> {
  return {
    ...input.scenario.env,
    GROUNDCREW_WORKSPACE: input.workspace,
    GROUNDCREW_TASK_ID: "fixture:TASK-1",
    GROUNDCREW_TEST_AGENT_SCRIPT: agentScriptsDirectory({ scenario: input.scenario }),
    ...input.extra,
  };
}

async function makeWorkspace(input: {
  readonly scenario: Scenario;
}): Promise<{ workspace: string; repoDirectory: string }> {
  const workspace = path.join(input.scenario.root, "ws");
  const repoDirectory = path.join(workspace, "alpha");
  fs.mkdirSync(repoDirectory, { recursive: true });
  await run({ command: "git", args: ["init", "-b", "main"], cwd: repoDirectory, env: input.scenario.env });
  return { workspace, repoDirectory };
}

describe("scriptedAgent", () => {
  it("executes writeFile, gitCommit, crew, sleep and waitForFile deterministically", async () => {
    await withScenario(async (scenario) => {
      installScriptedAgent({ scenario });
      const { workspace, repoDirectory } = await makeWorkspace({ scenario });
      fs.writeFileSync(path.join(workspace, "ready.txt"), "go\n");

      const crewLog = path.join(scenario.root, "crew-calls.jsonl");
      const shim = makeRecordingShim({ scenario, name: "crew-rec", logPath: crewLog });

      const steps: AgentStep[] = [
        { type: "writeFile", path: "alpha/feature.txt", content: "hello\n" },
        { type: "gitCommit", repo: "alpha", message: "agent commit" },
        { type: "crew", args: ["done", "--outcome", "delivered"] },
        { type: "sleep", milliseconds: 10 },
        { type: "waitForFile", path: "ready.txt" },
      ];
      writeAgentScript({ scenario, steps });

      const result = await run({
        command: "scripted-agent",
        env: agentEnv({ scenario, workspace, extra: { GROUNDCREW_E2E_CREW_BIN: shim } }),
      });

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(workspace, "alpha", "feature.txt"), "utf8")).toBe(
        "hello\n",
      );
      expect(await commitSubjects({ scenario, repoDirectory })).toContain("agent commit");
      expect(readCallLog(crewLog)[0]?.argv).toEqual(["done", "--outcome", "delivered"]);
      expect(fs.existsSync(heartbeatPath({ workspaceDirectory: workspace }))).toBe(true);
    });
  });

  it("honors the exitCode step", async () => {
    await withScenario(async (scenario) => {
      installScriptedAgent({ scenario });
      const { workspace } = await makeWorkspace({ scenario });
      writeAgentScript({ scenario, steps: [{ type: "exitCode", code: 3 }] });

      const result = await run({
        command: "scripted-agent",
        env: agentEnv({ scenario, workspace }),
      });
      expect(result.exitCode).toBe(3);
    });
  });

  it("writes a heartbeat and hangs until killed", async () => {
    await withScenario(async (scenario) => {
      installScriptedAgent({ scenario });
      const { workspace } = await makeWorkspace({ scenario });
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      const child = execa("scripted-agent", [], {
        env: agentEnv({ scenario, workspace }),
        extendEnv: false,
        reject: false,
      });

      try {
        await waitForHeartbeat({ workspaceDirectory: workspace });
        expect(fs.existsSync(heartbeatPath({ workspaceDirectory: workspace }))).toBe(true);
      } finally {
        child.kill("SIGKILL");
        await child;
      }
    });
  });

  it("records a --resume session id and continues", async () => {
    await withScenario(async (scenario) => {
      installScriptedAgent({ scenario });
      const { workspace } = await makeWorkspace({ scenario });
      writeAgentScript({ scenario, steps: [] });

      const result = await run({
        command: "scripted-agent",
        args: ["--resume", "SID-1"],
        env: agentEnv({ scenario, workspace }),
      });

      expect(result.exitCode).toBe(0);
      const records = readResumeRecords({ workspaceDirectory: workspace });
      expect(records).toHaveLength(1);
      expect(records[0]?.sessionId).toBe("SID-1");
    });
  });
});
