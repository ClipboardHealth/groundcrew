/**
 * `crew upgrade [version]`: install the latest (or a pinned) version globally
 * (contracts §7, prototype). The npm invocation goes through an injectable
 * runner so unit tests and the hermetic e2e suite never touch the global npm
 * prefix; the default runner shells out with execa.
 */
import { execa } from "execa";

import type { Io } from "../io.js";

const PACKAGE = "@clipboard-health/groundcrew";

export interface UpgradeRunner {
  install(spec: string): Promise<void>;
}

/** The real runner: `npm install -g <spec>`. */
export const npmUpgradeRunner: UpgradeRunner = {
  async install(spec: string): Promise<void> {
    await execa("npm", ["install", "-g", spec], { stdio: "inherit" });
  },
};

export async function runUpgrade(input: {
  readonly version?: string;
  readonly io: Io;
  readonly runner?: UpgradeRunner;
  /** When true, print the command and do nothing (default off; e2e sets it). */
  readonly printOnly?: boolean;
}): Promise<void> {
  const spec = input.version === undefined ? `${PACKAGE}@latest` : `${PACKAGE}@${input.version}`;
  input.io.out(`Installing ${spec} …`);
  input.io.out(`  npm install -g ${spec}`);

  if (input.printOnly === true) {
    return;
  }

  const runner = input.runner ?? npmUpgradeRunner;
  await runner.install(spec);
  input.io.out("Done.");
}
