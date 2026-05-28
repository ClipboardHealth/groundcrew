import { ensureClearance } from "@clipboard-health/clearance";

import {
  hasPreLaunchEnv,
  type LocalRunner,
  type ModelDefinition,
  type ResolvedConfig,
} from "./config.ts";
import { detectHostCapabilities } from "./host.ts";
import { assertLocalRunnerRequirements, resolveLocalRunner } from "./localRunner.ts";
import { sandboxNameFor } from "./sandboxName.ts";
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
  if (runner === "sdx" && input.definition.preLaunch !== undefined) {
    throw new Error(
      `Local groundcrew ${input.purpose} with the sdx runner do not support preLaunch on model '${input.model}'. ` +
        "Use local.runner 'safehouse' or 'none', or remove preLaunch from the model.",
    );
  }
  if (runner === "sdx" && hasPreLaunchEnv(input.definition)) {
    throw new Error(
      `Local groundcrew ${input.purpose} with the sdx runner do not support preLaunchEnv on model '${input.model}'. ` +
        "Use local.runner 'safehouse' or 'none', or remove preLaunchEnv from the model.",
    );
  }
  // Mirror of buildLaunchCommand's defense — fail at config-resolution time so
  // the operator sees the problem before the workspace is spawned, not deep in
  // the launch shell. The buildLaunchCommand check stays as defense in depth.
  if (
    runner === "safehouse" &&
    hasPreLaunchEnv(input.definition) &&
    /^safehouse(\s|$)/.test(input.definition.cmd)
  ) {
    throw new Error(
      `Local groundcrew ${input.purpose} on model '${input.model}' cannot inject preLaunchEnv when 'cmd' already starts with 'safehouse'. ` +
        "Your cmd owns the wrap, so add the names to its own '--env-pass=' flag, or drop the 'safehouse' prefix from 'cmd' to let groundcrew compose the flag for you.",
    );
  }

  const sandboxName =
    runner === "sdx" && input.definition.sandbox !== undefined
      ? sandboxNameFor({ agent: input.definition.sandbox.agent })
      : undefined;
  return { runner, sandboxName };
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
