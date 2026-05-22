import { resolve } from "node:path";

import { runCommandAsync } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig, type SandboxDefinition } from "../lib/config.ts";
import { ensureSandbox, sandboxNameFor } from "../lib/dockerSandbox.ts";
import { writeOutput } from "../lib/util.ts";

interface SandboxModel {
  modelName: string;
  sandbox: SandboxDefinition;
  sandboxName: string;
}

const USAGE = [
  "Usage: crew sandbox <verb> [...args]",
  "",
  "Verbs:",
  "  list                      Show every groundcrew-owned sandbox known to sbx",
  "  ensure [<model>]          Provision the sandbox for one model, or all when omitted",
  "  regenerate <model>|--all  Tear down and recreate from current template/kits",
  "  auth <model>              Run the agent binary interactively for first-time login",
  "  rm <model>                Remove the sandbox for a model",
  "  template show             Print resolved agent/template/kits per configured sandbox model",
].join("\n");

function sandboxModels(config: ResolvedConfig): SandboxModel[] {
  const models: SandboxModel[] = [];
  for (const [modelName, definition] of Object.entries(config.models.definitions)) {
    const { sandbox } = definition;
    if (sandbox === undefined) {
      continue;
    }
    models.push({
      modelName,
      sandbox,
      sandboxName: sandboxNameFor({ agent: sandbox.agent }),
    });
  }
  return models;
}

function resolveModel(config: ResolvedConfig, modelName: string): SandboxModel {
  const definition = config.models.definitions[modelName];
  if (definition === undefined) {
    throw new Error(`crew sandbox: unknown model '${modelName}'`);
  }
  if (definition.sandbox === undefined) {
    throw new Error(`crew sandbox: model '${modelName}' has no sandbox config`);
  }
  return {
    modelName,
    sandbox: definition.sandbox,
    sandboxName: sandboxNameFor({ agent: definition.sandbox.agent }),
  };
}

function requireOnePositional(argv: string[], usage: string): string {
  const [first, ...rest] = argv;
  if (first === undefined || rest.length > 0) {
    throw new Error(usage);
  }
  return first;
}

async function runList(): Promise<void> {
  const output = await runCommandAsync("sbx", ["ls"]);
  const groundcrewRows = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name): name is string => name !== undefined && name.startsWith("groundcrew-"));
  if (groundcrewRows.length === 0) {
    writeOutput("(none)");
    return;
  }
  for (const name of groundcrewRows) {
    writeOutput(name);
  }
}

async function ensureOne(config: ResolvedConfig, model: SandboxModel): Promise<void> {
  await ensureSandbox({
    sandboxName: model.sandboxName,
    sandbox: model.sandbox,
    mountPath: resolve(config.workspace.projectDir),
  });
}

async function runEnsure(config: ResolvedConfig, argv: string[]): Promise<void> {
  const targets =
    argv.length === 0
      ? sandboxModels(config)
      : [resolveModel(config, requireOnePositional(argv, "Usage: crew sandbox ensure [<model>]"))];
  for (const model of targets) {
    // oxlint-disable-next-line no-await-in-loop -- sbx create is intentionally sequential; parallel daemon writes race
    await ensureOne(config, model);
  }
}

async function removeOne(model: SandboxModel): Promise<void> {
  await runCommandAsync("sbx", ["rm", "--force", model.sandboxName]);
}

function regenerateTargets(config: ResolvedConfig, argv: string[]): SandboxModel[] {
  const target = requireOnePositional(argv, "Usage: crew sandbox regenerate <model>|--all");
  if (target === "--all") {
    return sandboxModels(config);
  }
  return [resolveModel(config, target)];
}

async function runRegenerate(config: ResolvedConfig, argv: string[]): Promise<void> {
  for (const model of regenerateTargets(config, argv)) {
    // oxlint-disable-next-line no-await-in-loop -- sbx rm/create are intentionally sequential
    await removeOne(model);
    // oxlint-disable-next-line no-await-in-loop -- sbx rm/create are intentionally sequential
    await ensureOne(config, model);
  }
}

async function runAuth(config: ResolvedConfig, argv: string[]): Promise<void> {
  const modelName = requireOnePositional(argv, "Usage: crew sandbox auth <model>");
  const model = resolveModel(config, modelName);
  await ensureOne(config, model);
  await runCommandAsync("sbx", ["exec", "-it", model.sandboxName, model.sandbox.agent], {
    stdio: "inherit",
  });
}

async function runRemove(config: ResolvedConfig, argv: string[]): Promise<void> {
  const modelName = requireOnePositional(argv, "Usage: crew sandbox rm <model>");
  await removeOne(resolveModel(config, modelName));
}

function runTemplateShow(config: ResolvedConfig): void {
  const models = sandboxModels(config);
  if (models.length === 0) {
    writeOutput("(no sandbox models configured)");
    return;
  }
  for (const model of models) {
    writeOutput(`${model.modelName} → ${model.sandboxName}`);
    writeOutput(`  agent:    ${model.sandbox.agent}`);
    writeOutput(`  template: ${model.sandbox.template ?? "(default)"}`);
    const kits = model.sandbox.kits ?? [];
    writeOutput(`  kits:     ${kits.length === 0 ? "(none)" : kits.join(", ")}`);
  }
}

async function runTemplate(config: ResolvedConfig, argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "show" && rest.length === 0) {
    runTemplateShow(config);
    return;
  }
  throw new Error("Usage: crew sandbox template show");
}

export async function sandboxCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    throw new Error(USAGE);
  }
  const config = await loadConfig();
  switch (verb) {
    case "list": {
      await runList();
      return;
    }
    case "ensure": {
      await runEnsure(config, rest);
      return;
    }
    case "regenerate": {
      await runRegenerate(config, rest);
      return;
    }
    case "auth": {
      await runAuth(config, rest);
      return;
    }
    case "rm": {
      await runRemove(config, rest);
      return;
    }
    case "template": {
      await runTemplate(config, rest);
      return;
    }
    default: {
      throw new Error(`Unknown sandbox sub-verb: ${verb}\n${USAGE}`);
    }
  }
}
