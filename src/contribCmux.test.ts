import { readFileSync } from "node:fs";

const SIDEBAR_PATH = new URL("../contrib/cmux/groundcrew.swift", import.meta.url);

describe("cmux contrib sidebar", () => {
  it("preserves the dirty-worktree guard during cleanup", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).not.toContain('crew cleanup " + task + " --force');
  });

  it("reports success only after cleanup succeeds", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain(
      'crew cleanup " + task + " && { cmux workspace close " + w.id + "; echo; echo \'✓ cleanup finished — close this tab when done\'; }"',
    );
  });
});
