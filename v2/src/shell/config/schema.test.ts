import { describe, expect, it } from "vitest";

import { configSchema } from "./schema.js";

describe("configSchema", () => {
  const minimal = { workspace: { baseDirectory: "~/dev" } };

  it("accepts the minimal legal config (only workspace.baseDirectory)", () => {
    const result = configSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("accepts the full contracts §5 shape", () => {
    const result = configSchema.safeParse({
      $schema: "…/schema.json",
      workspace: {
        baseDirectory: "~/dev",
        worktreeDirectory: "~/scratch/worktrees",
        repositories: { alpha: { workingDirectory: "packages/api", prepareWorktree: "npm ci" } },
      },
      sources: [
        { kind: "fixture", name: "fixture", agent: "scripted", sandbox: true, environment: { X: "y" } },
      ],
      agents: {
        default: "scripted",
        profiles: { scripted: { command: "a {{prompt}}", resume: "a --resume {{sessionId}}", model: "m1", effort: "high" } },
      },
      orchestrator: { maximumInProgress: 4, pollIntervalMilliseconds: 120000, sessionLimitPercentage: 85 },
      git: { remote: "origin", defaultBranch: "main", branchPrefix: "crew" },
      presenter: "tmux",
      sandbox: { readOnlyDirectories: ["~/.config/tfenv"], network: ["api.github.com"] },
      prompts: { initial: "hi" },
      logging: { file: "~/x.jsonl" },
    });
    expect(result.success).toBe(true);
  });

  it("requires workspace.baseDirectory", () => {
    expect(configSchema.safeParse({ workspace: {} }).success).toBe(false);
    expect(configSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty-string agent designation (schema error, not unrouted)", () => {
    expect(configSchema.safeParse({ ...minimal, sources: [{ kind: "x", agent: "" }] }).success).toBe(
      false,
    );
    expect(
      configSchema.safeParse({ ...minimal, agents: { default: "" } }).success,
    ).toBe(false);
  });

  it("rejects an unknown presenter", () => {
    expect(configSchema.safeParse({ ...minimal, presenter: "screen" }).success).toBe(false);
  });

  it("accepts each valid presenter", () => {
    for (const presenter of ["cmux", "tmux", "zellij"]) {
      expect(configSchema.safeParse({ ...minimal, presenter }).success).toBe(true);
    }
  });
});
