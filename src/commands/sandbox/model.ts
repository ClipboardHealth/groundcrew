import type { ResolvedConfig, SandboxDefinition } from "../../lib/config.ts";
import { sandboxNameFor } from "../../lib/dockerSandbox.ts";

export interface SandboxModel {
  modelName: string;
  sandbox: SandboxDefinition;
  sandboxName: string;
}

export function sandboxModels(config: ResolvedConfig): SandboxModel[] {
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

export function resolveModel(config: ResolvedConfig, modelName: string): SandboxModel {
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

export function requireOnePositional(argv: string[], usage: string): string {
  const [first, ...rest] = argv;
  if (first === undefined || rest.length > 0) {
    throw new Error(usage);
  }
  return first;
}
