import { resolve } from "node:path";

import { ensureClearance } from "@clipboard-health/clearance";

import type { LocalRunner, ModelDefinition, ResolvedConfig } from "./config.ts";
import { ensureSandbox, sandboxNameFor } from "./dockerSandbox.ts";
import { detectHostCapabilities } from "./host.ts";
import { assertLocalRunnerRequirements, resolveLocalRunner } from "./localRunner.ts";
import { log, sleep } from "./util.ts";
import { workspaces } from "./workspaces.ts";

interface PreparedAgentLaunch {
  runner: LocalRunner;
  sandboxName: string | undefined;
}

export async function prepareAgentLaunch(input: {
  config: ResolvedConfig;
  model: string;
  definition: ModelDefinition;
  purpose: "runs" | "resumes";
  signal?: AbortSignal;
}): Promise<PreparedAgentLaunch> {
  const host = await detectHostCapabilities(input.signal);
  const runner = resolveLocalRunner(input.config.local.runner, host);
  assertLocalRunnerRequirements(host, runner);
  if (runner === "safehouse") {
    await ensureClearance({
      logger: log,
      ...(input.signal === undefined
        ? {}
        : {
            sleep: async (ms) => {
              await sleep(ms, input.signal);
              input.signal?.throwIfAborted();
            },
          }),
    });
    input.signal?.throwIfAborted();
  }
  if (runner === "sdx" && input.definition.sandbox === undefined) {
    throw new Error(
      `Local groundcrew ${input.purpose} with the sdx runner require a sandbox config on model '${input.model}'.`,
    );
  }

  const sandboxName =
    runner === "sdx" && input.definition.sandbox !== undefined
      ? sandboxNameFor({ agent: input.definition.sandbox.agent })
      : undefined;
  return { runner, sandboxName };
}

export async function ensureAgentSandbox(input: {
  config: ResolvedConfig;
  definition: ModelDefinition;
  sandboxName: string | undefined;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.sandboxName !== undefined && input.definition.sandbox !== undefined) {
    await ensureSandbox(
      {
        sandboxName: input.sandboxName,
        sandbox: input.definition.sandbox,
        mountPath: resolve(input.config.workspace.projectDir),
        gitDefaults: input.config.sandbox.gitDefaults,
      },
      input.signal,
    );
  }
}

export async function openAgentWorkspace(input: {
  config: ResolvedConfig;
  name: string;
  cwd: string;
  command: string;
  model: string;
  color: string;
  signal?: AbortSignal;
}): Promise<void> {
  const spec = {
    name: input.name,
    cwd: input.cwd,
    command: input.command,
    status: { text: input.model, color: input.color, icon: "sparkle" },
  };
  await (input.signal === undefined
    ? workspaces.open(input.config, spec)
    : workspaces.open(input.config, spec, input.signal));
}
