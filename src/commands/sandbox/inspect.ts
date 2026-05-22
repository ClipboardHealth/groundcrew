import { runCommandAsync } from "../../lib/commandRunner.ts";
import { writeOutput } from "../../lib/util.ts";

const SANDBOX_NAME_PREFIX = "groundcrew-";

export async function runList(): Promise<void> {
  const output = await runCommandAsync("sbx", ["ls"]);
  const names = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name): name is string => name !== undefined && name.startsWith(SANDBOX_NAME_PREFIX))
    .map((name) => name.slice(SANDBOX_NAME_PREFIX.length));
  if (names.length === 0) {
    writeOutput("(none)");
    return;
  }
  for (const name of names) {
    writeOutput(name);
  }
}
