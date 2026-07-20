/**
 * The `crew.config.jsonc` zod schema (contracts §5, design §7.2). Two principles
 * shape it: omitted = detected (so nearly every section is optional and a
 * detector fills it later — {@link ../detect}), and no secrets structurally (no
 * field accepts a token value; sources declare secret NAMES in their manifest,
 * resolved by Acquisition). The published JSON Schema is generated from this
 * export; the coordinator wires that generation, so `configSchema` is exported.
 *
 * An empty-string agent designation anywhere is a schema error, never
 * "unrouted": unrouted means the field is absent (contracts §7). Hence every
 * identity-bearing string is `.min(1)`.
 */
import { z } from "zod";

/** Per-repo override under `workspace.repositories[<name>]`. */
export const repositoryOverrideSchema = z.object({
  workingDirectory: z.string().min(1).optional(),
  prepareWorktree: z.string().min(1).optional(),
});

export const workspaceConfigSchema = z.object({
  /** The only required key in the file (contracts §5). */
  baseDirectory: z.string().min(1),
  worktreeDirectory: z.string().min(1).optional(),
  /**
   * Non-secret env injected into every prepareWorktree hook process and layered
   * into every agent session (between ambient and profile.environment). The v2
   * home for v1's `preLaunch`/`preLaunchEnv` export passthroughs (contracts §5).
   */
  environment: z.record(z.string().min(1), z.string()).optional(),
  /** Default prepareWorktree hook when a repo has no per-repo override (v1's `defaults.hooks`). */
  prepareWorktree: z.string().min(1).optional(),
  repositories: z.record(z.string().min(1), repositoryOverrideSchema).optional(),
});

/** One enabled source bundle, keyed by discovered `kind` (contracts §5). */
export const sourceConfigSchema = z.object({
  kind: z.string().min(1),
  /** Effective name override; defaults to the discovered name. */
  name: z.string().min(1).optional(),
  /** Source-level agent designation; empty string is a schema error, not unrouted. */
  agent: z.string().min(1).optional(),
  /** `false` opts the source out of the sandbox — loud in status/doctor. */
  sandbox: z.boolean().optional(),
  /** Non-secret env merged over the manifest's `environment`. */
  environment: z.record(z.string().min(1), z.string()).optional(),
});

/** An `agents.profiles.<name>` entry: declarative harness config (contracts §5). */
export const agentProfileConfigSchema = z.object({
  command: z.string().min(1).optional(),
  resume: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  environment: z.record(z.string().min(1), z.string()).optional(),
});

export const agentsConfigSchema = z.object({
  /** Config-level default agent; empty string is a schema error. */
  default: z.string().min(1).optional(),
  profiles: z.record(z.string().min(1), agentProfileConfigSchema).optional(),
});

export const orchestratorConfigSchema = z.object({
  maximumInProgress: z.number().int().positive().optional(),
  pollIntervalMilliseconds: z.number().int().positive().optional(),
  sessionLimitPercentage: z.number().int().min(1).max(100).optional(),
});

export const gitConfigSchema = z.object({
  remote: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  branchPrefix: z.string().min(1).optional(),
});

/** The three in-core presenters (contracts §5, design §8). */
export const PRESENTER_NAMES = ["cmux", "tmux", "zellij"] as const;

export const sandboxConfigSchema = z.object({
  readOnlyDirectories: z.array(z.string().min(1)).optional(),
  /**
   * Agent-session egress allowlist (sources declare their own in manifests).
   * SPECIFIED replaces the built-in baseline wholesale (contracts §5 principle 1).
   */
  network: z.array(z.string().min(1)).optional(),
  /**
   * Hosts appended to the effective egress list rather than replacing it — the
   * additive alternative to `network` for the common "baseline plus a couple of
   * my hosts" case (contracts §5). Appended to the built-in baseline when
   * `network` is omitted, or to `network` when both are set.
   */
  additionalNetwork: z.array(z.string().min(1)).optional(),
});

export const promptsConfigSchema = z.object({
  initial: z.string().optional(),
  promptFile: z.string().min(1).optional(),
});

export const loggingConfigSchema = z.object({
  file: z.string().min(1).optional(),
});

/** The whole `crew.config.jsonc` document. */
export const configSchema = z.object({
  $schema: z.string().optional(),
  workspace: workspaceConfigSchema,
  sources: z.array(sourceConfigSchema).optional(),
  agents: agentsConfigSchema.optional(),
  orchestrator: orchestratorConfigSchema.optional(),
  git: gitConfigSchema.optional(),
  presenter: z.enum(PRESENTER_NAMES).optional(),
  sandbox: sandboxConfigSchema.optional(),
  prompts: promptsConfigSchema.optional(),
  logging: loggingConfigSchema.optional(),
});

export type Config = z.infer<typeof configSchema>;
export type WorkspaceConfigSection = z.infer<typeof workspaceConfigSchema>;
export type SourceConfigSection = z.infer<typeof sourceConfigSchema>;
export type AgentProfileConfigSection = z.infer<typeof agentProfileConfigSchema>;
export type AgentsConfigSection = z.infer<typeof agentsConfigSchema>;
export type PresenterName = (typeof PRESENTER_NAMES)[number];
