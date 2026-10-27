import type { TeardownResult } from "../lib/worktrees.ts";

export function emptyTeardownResult(overrides: Partial<TeardownResult> = {}): TeardownResult {
  return {
    closed: [],
    removed: [],
    inUse: [],
    failures: [],
    workspaceProbe: { kind: "ok", names: new Set<string>() },
    ...overrides,
  };
}
