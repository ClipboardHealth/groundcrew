/**
 * Agent profiles: declarative harness config resolved into a launch command
 * template (contracts §5, design doc §7.2). Two shapes:
 *
 *  - Presets (`claude` / `codex` / `cursor`): first-class `model`/`effort`
 *    mapped to each CLI's REAL flags, with a built-in resume form. Flag shapes
 *    were verified against the installed CLIs and the v1 presets we ported
 *    (`--permission-mode auto` for claude, `--dangerously-bypass-approvals-and-
 *    sandbox` for codex, `--sandbox disabled --force --approve-mcps` for cursor).
 *  - Custom profiles: a `command` template with `{{prompt}}`/`{{model}}`
 *    placeholders, an optional `resume` template with `{{sessionId}}`, an
 *    `environment` map, and `--fresh` (ignore any captured session id). A
 *    profile named after a preset but carrying its own `command` is custom.
 *
 * Session-id capture is a per-preset seam kept deliberately honest: no v2.0
 * harness exposes a captured id through the presenter (detached panes give core
 * no stdout), so every capture hook returns `undefined` and resume falls back
 * to the built-in cwd/latest resume form. The seam exists for future harnesses.
 */

import { shellQuote } from "./shellCommand.js";

export const PRESET_NAMES = ["claude", "codex", "cursor"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** Declarative profile config (the `agents.profiles.<name>` entry, contracts §5). */
export interface AgentProfileConfig {
  /** Custom command template with `{{prompt}}`/`{{model}}`; presence ⇒ custom profile. */
  command?: string;
  /** Custom resume template with `{{sessionId}}`; presets have a built-in form. */
  resume?: string;
  model?: string;
  effort?: string;
  /** Non-secret env injected into the agent session at launch (contracts §5). */
  environment?: Record<string, string>;
  /** `--fresh`: ignore any captured session id on resume (new session, same run). */
  fresh?: boolean;
}

/** A capture hook: given whatever the harness surfaced, extract a session id. */
export type SessionIdCapture = (input: { output?: string }) => string | undefined;

/** No v2.0 harness exposes a captured id through the presenter. */
// oxlint-disable-next-line unicorn/no-useless-undefined -- the honest "captured nothing" sentinel this seam is built around
export const noSessionIdCapture: SessionIdCapture = () => undefined;

/** A profile resolved into concrete command templates and launch metadata. */
export interface ResolvedProfile {
  name: string;
  /** Launch command template; contains `{{prompt}}` (and `{{model}}` for custom). */
  commandTemplate: string;
  /** Resume command template, or `undefined` for a custom profile without one. */
  resumeTemplate: string | undefined;
  model: string | undefined;
  environment: Record<string, string>;
  fresh: boolean;
  captureSessionId: SessionIdCapture;
}

export class ProfileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/**
 * Resolve a named profile config into its command templates. A preset name with
 * no `command` yields the built-in preset; any `command` makes it custom; a
 * non-preset name with no `command` is a configuration error.
 */
export function resolveProfile(input: {
  name: string;
  profile: AgentProfileConfig;
}): ResolvedProfile {
  const { name, profile } = input;
  const environment = { ...profile.environment };
  const fresh = profile.fresh ?? false;

  if (profile.command !== undefined) {
    return {
      name,
      commandTemplate: profile.command,
      resumeTemplate: profile.resume,
      model: profile.model,
      environment,
      fresh,
      captureSessionId: noSessionIdCapture,
    };
  }

  if (isPresetName(name)) {
    const preset = buildPreset({
      name,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
    });
    return {
      name,
      commandTemplate: preset.command,
      resumeTemplate: profile.resume ?? preset.resume,
      model: profile.model,
      environment,
      fresh,
      captureSessionId: noSessionIdCapture,
    };
  }

  throw new ProfileError(
    `agent profile "${name}" has no command and is not a known preset (${PRESET_NAMES.join(", ")})`,
  );
}

/** Substitute a resolved profile's launch template with the prompt (and model). */
export function composeLaunchCommand(input: {
  profile: ResolvedProfile;
  prompt: string;
}): string {
  return substitute(input.profile.commandTemplate, {
    prompt: shellQuote(input.prompt),
    model: quotedModel(input.profile.model),
    sessionId: "",
  });
}

/**
 * Substitute a resolved profile's resume template with the captured session id.
 * `--fresh` (or a profile that exposes no id) blanks `{{sessionId}}`. Returns
 * `undefined` when the profile has no resume form.
 */
export function composeResumeCommand(input: {
  profile: ResolvedProfile;
  sessionId?: string;
}): string | undefined {
  const { profile } = input;
  if (profile.resumeTemplate === undefined) {
    return undefined;
  }
  const effectiveId = profile.fresh ? undefined : input.sessionId;
  return substitute(profile.resumeTemplate, {
    prompt: "",
    model: quotedModel(profile.model),
    sessionId: effectiveId === undefined || effectiveId.length === 0 ? "" : shellQuote(effectiveId),
  });
}

/** The instruction the default initial prompt closes with (contracts §9). */
export const CREW_DONE_INSTRUCTION =
  "When you have finished the task, run `crew done` (add `--outcome failed` if you could not complete it) so groundcrew records the result.";

/**
 * The default initial prompt: the task prose (when provided) followed by the
 * `crew done` instruction. Callers own prompt policy (contracts §5 `prompts`);
 * Session exports the default so the closing instruction is defined in one
 * place.
 */
export function defaultInitialPrompt(input: { task?: string } = {}): string {
  const task = input.task?.trim();
  return task === undefined || task.length === 0
    ? CREW_DONE_INSTRUCTION
    : `${task}\n\n${CREW_DONE_INSTRUCTION}`;
}

export function isPresetName(name: string): name is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(name);
}

interface PresetTemplates {
  command: string;
  resume: string;
}

function buildPreset(input: {
  name: PresetName;
  model?: string;
  effort?: string;
}): PresetTemplates {
  switch (input.name) {
    case "claude": {
      const base = ["claude", "--permission-mode", "auto"];
      if (input.model !== undefined) {
        base.push("--model", shellQuote(input.model));
      }
      if (input.effort !== undefined) {
        base.push("--effort", shellQuote(input.effort));
      }
      return { command: join([...base, "{{prompt}}"]), resume: join([...base, "--continue"]) };
    }
    case "codex": {
      const base = ["codex", "--dangerously-bypass-approvals-and-sandbox"];
      if (input.model !== undefined) {
        base.push("--model", shellQuote(input.model));
      }
      if (input.effort !== undefined) {
        base.push("-c", shellQuote(`model_reasoning_effort=${input.effort}`));
      }
      return { command: join([...base, "{{prompt}}"]), resume: join([...base, "resume", "--last"]) };
    }
    case "cursor": {
      const model = input.model ?? "composer-2.5";
      // Boolean flags trail the value-bearing `--model` so a naive PATH-probe
      // tokenizer resolves the executable correctly (ported from the v1 preset).
      const base = ["cursor-agent", "--model", shellQuote(model), "--sandbox", "disabled", "--force", "--approve-mcps"];
      return { command: join([...base, "{{prompt}}"]), resume: join([...base, "--continue"]) };
    }
    default: {
      /* v8 ignore next @preserve -- input.name is PresetName; this arm only satisfies exhaustiveness */
      throw new ProfileError(`unknown preset "${String(input.name)}"`);
    }
  }
}

function join(tokens: readonly string[]): string {
  return tokens.join(" ");
}

function quotedModel(model: string | undefined): string {
  return model === undefined || model.length === 0 ? "" : shellQuote(model);
}

function substitute(
  template: string,
  values: { prompt: string; model: string; sessionId: string },
): string {
  // No whitespace normalization: collapsing spaces would corrupt content inside
  // a quoted prompt. Empty placeholders leave harmless extra spaces the shell
  // ignores during word splitting; only the ends are trimmed.
  return template
    .replaceAll("{{prompt}}", values.prompt)
    .replaceAll("{{model}}", values.model)
    .replaceAll("{{sessionId}}", values.sessionId)
    .trim();
}
