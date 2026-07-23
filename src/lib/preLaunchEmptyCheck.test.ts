import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { buildPreLaunchEmptyCheckLines } from "./preLaunchEmptyCheck.ts";

/**
 * Run a `sh -c` script and return the exit code plus captured stderr.
 * Uses `/bin/sh` — the same shell the launchCommand tests use — so the
 * emitted snippet is proven to work under whatever `sh` the host provides
 * (bash-in-POSIX-mode on macOS, dash on many Linux CIs).
 *
 * A hermetic env (`{}`) is intentional: inheriting `process.env` would let
 * ambient state leak into assertions about "the var is unset".
 */
function runShell(script: string): { status: number; stderr: string } {
  const result = spawnSync("sh", ["-c", script], { env: {} });
  return { status: result.status ?? -1, stderr: result.stderr.toString() };
}

describe(buildPreLaunchEmptyCheckLines, () => {
  it("returns [] for an empty name list", () => {
    const actual = buildPreLaunchEmptyCheckLines([]);

    expect(actual).toEqual([]);
  });

  it("deduplicates repeated names", () => {
    const actual = buildPreLaunchEmptyCheckLines(["X", "X", "Y"]);

    expect(actual).toHaveLength(2);
  });

  it("emits a stderr diagnostic when the named var is set to an empty string", () => {
    const [line] = buildPreLaunchEmptyCheckLines(["TOKEN"]);

    const { status, stderr } = runShell(`TOKEN=""; ${line}`);

    expect(status).toBe(0);
    expect(stderr).toContain("preLaunchEnv: TOKEN is empty after preLaunch (value length 0)");
  });

  it("emits a stderr diagnostic when the named var is unset", () => {
    const [line] = buildPreLaunchEmptyCheckLines(["TOKEN"]);

    const { status, stderr } = runShell(`${line}`);

    expect(status).toBe(0);
    expect(stderr).toContain("preLaunchEnv: TOKEN is empty after preLaunch (value length 0)");
  });

  it("emits one diagnostic per empty name and nothing for names that are set", () => {
    const lines = buildPreLaunchEmptyCheckLines(["A", "B", "C"]);

    const script = `B=ok; ${lines.join(" && ")}`;
    const { status, stderr } = runShell(script);

    expect(status).toBe(0);
    expect(stderr).toContain("preLaunchEnv: A is empty after preLaunch (value length 0)");
    expect(stderr).not.toContain("preLaunchEnv: B is empty");
    expect(stderr).toContain("preLaunchEnv: C is empty after preLaunch (value length 0)");
  });

  it("participates in an `&&` chain so a failing preLaunch still short-circuits", () => {
    const [line] = buildPreLaunchEmptyCheckLines(["TOKEN"]);

    const { status, stderr } = runShell(`false && ${line} && echo REACHED`);

    expect(status).not.toBe(0);
    expect(stderr).not.toContain("preLaunchEnv: TOKEN is empty");
  });
});
