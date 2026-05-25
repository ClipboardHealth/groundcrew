import { resolve } from "node:path";

import { runCommandAsync } from "../../lib/commandRunner.ts";
import type { ResolvedConfig } from "../../lib/config.ts";
import { ensureSandbox, sandboxExists } from "../../lib/dockerSandbox.ts";
import { writeOutput } from "../../lib/util.ts";
import { requireOnePositional, resolveModel, type SandboxModel, sandboxModels } from "./model.ts";

export async function ensureOne(
  config: ResolvedConfig,
  model: SandboxModel,
  alreadyExists?: boolean,
): Promise<void> {
  await ensureSandbox({
    sandboxName: model.sandboxName,
    sandbox: model.sandbox,
    mountPath: resolve(config.workspace.projectDir),
    gitDefaults: config.sandbox.gitDefaults,
    ...(alreadyExists === undefined ? {} : { alreadyExists }),
  });
}

async function removeOne(model: SandboxModel): Promise<void> {
  await runCommandAsync("sbx", ["rm", "--force", model.sandboxName]);
}

export async function runEnsure(config: ResolvedConfig, argv: string[]): Promise<void> {
  const targets =
    argv.length === 0
      ? sandboxModels(config)
      : [resolveModel(config, requireOnePositional(argv, "Usage: crew sandbox ensure [<model>]"))];
  if (targets.length === 0) {
    writeOutput("No sandbox models configured.");
    return;
  }
  for (const model of targets) {
    // oxlint-disable-next-line no-await-in-loop -- one sandbox at a time; probe then ensure
    const existed = await sandboxExists(model.sandboxName);
    writeOutput(
      existed
        ? `${model.sandboxName}: already exists`
        : `${model.sandboxName}: creating (agent=${model.sandbox.agent}, template=${model.sandbox.template ?? "default"})`,
    );
    // oxlint-disable-next-line no-await-in-loop -- sbx create is intentionally sequential
    await ensureOne(config, model, existed);
    if (!existed) {
      writeOutput(`${model.sandboxName}: created`);
    }
  }
}

function regenerateTargets(config: ResolvedConfig, argv: string[]): SandboxModel[] {
  const target = requireOnePositional(argv, "Usage: crew sandbox regenerate <model>|--all");
  if (target === "--all") {
    return sandboxModels(config);
  }
  return [resolveModel(config, target)];
}

export async function runRegenerate(config: ResolvedConfig, argv: string[]): Promise<void> {
  const targets = regenerateTargets(config, argv);
  if (targets.length === 0) {
    writeOutput("No sandbox models configured.");
    return;
  }
  for (const model of targets) {
    writeOutput(`${model.sandboxName}: removing existing sandbox...`);
    // oxlint-disable-next-line no-await-in-loop -- sbx rm/create are intentionally sequential
    await removeOne(model);
    writeOutput(
      `${model.sandboxName}: creating (agent=${model.sandbox.agent}, template=${model.sandbox.template ?? "default"})`,
    );
    // oxlint-disable-next-line no-await-in-loop -- sbx rm/create are intentionally sequential
    await ensureOne(config, model, false);
    writeOutput(`${model.sandboxName}: regenerated`);
  }
}

export async function runRemove(config: ResolvedConfig, argv: string[]): Promise<void> {
  const modelName = requireOnePositional(argv, "Usage: crew sandbox rm <model>");
  const model = resolveModel(config, modelName);
  writeOutput(`${model.sandboxName}: removing...`);
  await removeOne(model);
  writeOutput(`${model.sandboxName}: removed`);
}
