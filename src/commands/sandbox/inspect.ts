import { runCommandAsync } from "../../lib/commandRunner.ts";
import type { ResolvedConfig } from "../../lib/config.ts";
import { writeOutput } from "../../lib/util.ts";
import { sandboxModels } from "./model.ts";

export async function runList(): Promise<void> {
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

export async function runTemplate(config: ResolvedConfig, argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "show" && rest.length === 0) {
    runTemplateShow(config);
    return;
  }
  throw new Error("Usage: crew sandbox template show");
}
