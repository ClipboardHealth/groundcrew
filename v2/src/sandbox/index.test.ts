import { readFileSync } from "node:fs";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";

import { isSandboxRunnerAvailable, resolveSrtCli, wrapCommand } from "./index.js";

/** Pull the staged settings path out of a `--settings '<file>'` invocation. */
function settingsFileFrom(command: string): string {
  const match = /--settings '([^']+)'/u.exec(command);
  if (match?.[1] === undefined) {
    throw new Error(`no --settings in composed command: ${command}`);
  }
  return match[1];
}

describe(wrapCommand, () => {
  it("wraps the command under srt with a staged, schema-valid settings file", async () => {
    const { command } = await wrapCommand({
      command: "echo hi",
      policy: { writablePaths: ["/work/ws"], readOnlyPaths: [], network: [] },
    });

    expect(command.startsWith(`'${resolveSrtCli()}'`)).toBe(true);
    expect(command.endsWith("-c 'echo hi'")).toBe(true);

    const settings = JSON.parse(readFileSync(settingsFileFrom(command), "utf8"));
    expect(() => SandboxRuntimeConfigSchema.parse(settings)).not.toThrow();
    expect(settings.filesystem.allowWrite).toContain("/work/ws");
    // Deny-by-default: the home region is masked even though the policy never mentions it.
    expect(settings.filesystem.denyRead.length).toBeGreaterThan(0);
  });

  it("returns only the composed command (seam is command in, command out)", async () => {
    const wrapped = await wrapCommand({
      command: "true",
      policy: { writablePaths: [], readOnlyPaths: [], network: [] },
    });

    expect(Object.keys(wrapped)).toStrictEqual(["command"]);
  });
});

describe(isSandboxRunnerAvailable, () => {
  it("resolves to a boolean for this host", async () => {
    expect(typeof (await isSandboxRunnerAvailable())).toBe("boolean");
  });
});
