import { runCommandAsync } from "../../lib/commandRunner.ts";
import { writeOutput } from "../../lib/util.ts";

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
