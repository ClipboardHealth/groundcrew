/**
 * Harness side of the scripted agent (catalog §1.4).
 *
 * Installs the committed `scripted-agent` executable onto the scenario PATH,
 * writes per-scenario or per-task step scripts, and offers sleepless
 * synchronization on the agent's heartbeat. The agent profile's `command` is
 * `scripted-agent {{prompt}}`; its `environment` carries
 * GROUNDCREW_TEST_AGENT_SCRIPT pointing at {@link agentScriptsDirectory}
 * (bindings.configure wires this).
 */

import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { taskSlug } from "./identity.js";
import { pollForValue, pollUntil } from "./poll.js";
import type { Scenario } from "./scenario.js";

/** A single scripted-agent step, executed in order (catalog §1 step set). */
export type AgentStep =
  | { readonly type: "writeFile"; readonly path: string; readonly content: string }
  | { readonly type: "gitCommit"; readonly repo: string; readonly message: string }
  | { readonly type: "crew"; readonly args: readonly string[] }
  | { readonly type: "sleep"; readonly milliseconds: number }
  | { readonly type: "waitForFile"; readonly path: string; readonly timeoutMilliseconds?: number }
  | { readonly type: "exitCode"; readonly code: number }
  | { readonly type: "hang" };

export const resumeRecordSchema = z.object({
  sessionId: z.string(),
  timestamp: z.string(),
});

export type ResumeRecord = z.infer<typeof resumeRecordSchema>;

/**
 * What the scripted agent recorded about its own launch: the argv it received
 * (the prompt positional) and the correlation/PATH env the session actually saw.
 * Lets a scenario assert the launch delivered the task context (prompt) and the
 * crew-bin PATH prepend (contracts §9), black-box.
 */
export const launchRecordSchema = z.object({
  argv: z.array(z.string()),
  env: z.object({
    GROUNDCREW_TASK_ID: z.string(),
    GROUNDCREW_WORKSPACE: z.string(),
    PATH: z.string(),
  }),
});

export type LaunchRecord = z.infer<typeof launchRecordSchema>;

/** Directory of per-task step scripts for a scenario; the value of GROUNDCREW_TEST_AGENT_SCRIPT. */
export function agentScriptsDirectory(input: { readonly scenario: Scenario }): string {
  return path.join(input.scenario.root, "agent-scripts");
}

/** Copies the `scripted-agent` executable onto the scenario PATH. Returns its path. */
export function installScriptedAgent(input: { readonly scenario: Scenario }): string {
  const source = path.resolve(
    fileDirectory(),
    "..",
    "fixtures",
    "scripted-agent",
    "scripted-agent",
  );
  const destination = path.join(input.scenario.fakesBinDirectory, "scripted-agent");
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
  return destination;
}

/**
 * Writes a step script. With a `taskId` it is keyed by task slug (concurrent
 * agents); without, it becomes `default.json` (the single-agent case). Returns
 * the written path.
 */
export function writeAgentScript(input: {
  readonly scenario: Scenario;
  readonly steps: readonly AgentStep[];
  readonly taskId?: string;
}): string {
  const directory = agentScriptsDirectory({ scenario: input.scenario });
  fs.mkdirSync(directory, { recursive: true });

  const fileName =
    input.taskId === undefined ? "default.json" : `${taskSlug({ taskId: input.taskId })}.json`;
  const target = path.join(directory, fileName);
  fs.writeFileSync(target, JSON.stringify({ steps: input.steps }, undefined, 2) + "\n");
  return target;
}

/** The heartbeat file path for a given workspace. */
export function heartbeatPath(input: { readonly workspaceDirectory: string }): string {
  return path.join(input.workspaceDirectory, ".groundcrew-test", "agent-heartbeat");
}

/**
 * Blocks until the scripted agent has written its heartbeat in `workspaceDirectory`.
 * With `sinceMilliseconds`, waits for a heartbeat newer than that epoch time
 * (used to detect a *fresh* start on resume).
 */
export async function waitForHeartbeat(input: {
  readonly workspaceDirectory: string;
  readonly sinceMilliseconds?: number;
  readonly timeoutMilliseconds?: number;
}): Promise<void> {
  const target = heartbeatPath({ workspaceDirectory: input.workspaceDirectory });
  await pollUntil({
    description: `scripted agent heartbeat at ${target}`,
    timeoutMilliseconds: input.timeoutMilliseconds,
    condition: () => {
      if (!fs.existsSync(target)) {
        return false;
      }

      if (input.sinceMilliseconds === undefined) {
        return true;
      }

      return fs.statSync(target).mtimeMs > input.sinceMilliseconds;
    },
  });
}

/** Reads the `--resume` records the agent wrote in `workspaceDirectory` (resume scenarios). */
export function readResumeRecords(input: {
  readonly workspaceDirectory: string;
}): ResumeRecord[] {
  const target = path.join(input.workspaceDirectory, ".groundcrew-test", "agent-resume");
  if (!fs.existsSync(target)) {
    return [];
  }

  return fs
    .readFileSync(target, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return resumeRecordSchema.parse(parsed);
    });
}

/** Blocks until at least `count` resume records exist, returning them. */
export async function waitForResume(input: {
  readonly workspaceDirectory: string;
  readonly count?: number;
  readonly timeoutMilliseconds?: number;
}): Promise<ResumeRecord[]> {
  const wanted = input.count ?? 1;
  return await pollForValue({
    description: `${String(wanted)} scripted agent resume record(s)`,
    timeoutMilliseconds: input.timeoutMilliseconds,
    probe: () => {
      const records = readResumeRecords({ workspaceDirectory: input.workspaceDirectory });
      return records.length >= wanted ? records : undefined;
    },
  });
}

/** Reads the launch record the agent wrote in `workspaceDirectory`, if any. */
export function readLaunchRecord(input: {
  readonly workspaceDirectory: string;
}): LaunchRecord | undefined {
  const target = path.join(input.workspaceDirectory, ".groundcrew-test", "agent-launch");
  if (!fs.existsSync(target)) {
    return undefined;
  }

  const line = fs
    .readFileSync(target, "utf8")
    .split("\n")
    .find((entry) => entry.trim() !== "");
  return line === undefined ? undefined : launchRecordSchema.parse(JSON.parse(line));
}

/** Blocks until the agent has written its launch record, returning it. */
export async function waitForLaunchRecord(input: {
  readonly workspaceDirectory: string;
  readonly timeoutMilliseconds?: number;
}): Promise<LaunchRecord> {
  return await pollForValue({
    description: `scripted agent launch record in ${input.workspaceDirectory}`,
    timeoutMilliseconds: input.timeoutMilliseconds,
    probe: () => readLaunchRecord({ workspaceDirectory: input.workspaceDirectory }),
  });
}

function fileDirectory(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}
