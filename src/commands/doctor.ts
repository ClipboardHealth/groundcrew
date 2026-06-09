/**
 * doctor — verify groundcrew prerequisites against the resolved config.
 * Returns true if every required check passes; false otherwise.
 */

import { existsSync, statSync } from "node:fs";

import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import {
  type ConfigSourceKind,
  type LocalRunner,
  type LocalRunnerSetting,
  loadConfigWithSource,
  type ResolvedConfig,
  worktreeBaseDir,
} from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities, which } from "../lib/host.ts";
import { resolveLocalRunner } from "../lib/localRunner.ts";
import { gatedModels } from "../lib/usage.ts";
import { errorMessage, writeOutput } from "../lib/util.ts";
import { resolveWorkspaceKind, type WorkspaceResolution } from "../lib/workspaces.ts";

// Tokenization stops after this many non-flag tokens. Two is enough to
// catch wrapper + wrapped CLI commands like `safehouse claude --foo`.
const MAX_TOKENS_PER_CMD = 2;
const BUILT_IN_MODEL_NAMES = ["claude", "codex"] as const;

const CONFIG_SOURCE_LABELS: Record<ConfigSourceKind, string> = {
  env: "GROUNDCREW_CONFIG",
  project: "project",
  xdg: "global XDG",
};

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  hint?: string;
}

async function checkCmd(cmd: string, required: boolean, hint?: string): Promise<Check> {
  const path = await which(cmd);
  const resolvedHint = path ?? hint;
  const result: Check = {
    name: cmd,
    ok: path !== undefined,
    required,
  };
  if (resolvedHint !== undefined) {
    result.hint = resolvedHint;
  }
  return result;
}

/**
 * Source-agnostic reachability check: build every configured task source
 * and run the Board's `verify()` fan-out. Replaces the old Linear-only
 * "api key + reachability" probe so a misconfigured shell (or future Jira)
 * source surfaces here too. A missing Linear API key still fails verify with
 * its own user-facing message, so the prior behavior is preserved.
 */
async function checkSourceProbe(config: ResolvedConfig): Promise<Check> {
  try {
    const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
    const board: Board = createBoard(sources);
    await board.verify();
    return {
      name: "source probe",
      ok: true,
      required: true,
      hint: `${sources.length} source(s) verified`,
    };
  } catch (error) {
    return { name: "source probe", ok: false, required: true, hint: errorMessage(error) };
  }
}

function checkDir(path: string, label: string): Check {
  // statSync can throw on permission errors or path races; surface those
  // as a failed check rather than letting them abort the whole doctor run.
  let exists = false;
  try {
    exists = existsSync(path) && statSync(path).isDirectory();
  } catch {
    exists = false;
  }
  return {
    name: `${label} (${path})`,
    ok: exists,
    required: true,
    hint: exists ? "exists" : `mkdir -p "${path}"`,
  };
}

/**
 * Tokens worth checking against PATH from a model's `cmd`:
 * the executable name (first non-flag token), and any subsequent
 * non-flag, non-flag-value token until a flag is hit. Flag tokens are
 * dropped along with the token immediately following them (treated as
 * the flag's value).
 *
 * Examples:
 *   "safehouse claude --permission-mode auto" → ["safehouse", "claude"]
 *   "claude"                                  → ["claude"]
 *   "node --inspect script.ts"                → ["node"]  (script.ts skipped — flag value)
 */
function commandTokensToCheck(cmd: string): string[] {
  const parts = cmd.trim().split(/\s+/);
  const result: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const token = parts[index];
    /* v8 ignore next 4 @preserve -- split(/\s+/) returns no undefined entries within bounds */
    if (token === undefined) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      // Skip the flag and its value (next token), if any.
      index += 2;
      continue;
    }
    result.push(token);
    if (result.length >= MAX_TOKENS_PER_CMD) {
      break;
    }
    index += 1;
  }
  return result;
}

interface ToolCheckTarget {
  token: string;
  hint?: string;
}

function gatherToolTargets(config: ResolvedConfig): ToolCheckTarget[] {
  const all = new Map<string, string | undefined>();
  for (const [modelName, definition] of Object.entries(config.models.definitions)) {
    for (const token of commandTokensToCheck(definition.cmd)) {
      const hint = modelCliHint(modelName, token);
      if (!all.has(token) || all.get(token) === undefined) {
        all.set(token, hint);
      }
    }
  }
  return [...all].map(([token, hint]) => (hint === undefined ? { token } : { token, hint }));
}

function modelCliHint(modelName: string, token: string): string | undefined {
  if (token !== modelName) {
    return undefined;
  }
  if (!isBuiltInModelName(modelName)) {
    return undefined;
  }
  return `install ${token} or remove \`models.definitions.${modelName}\` from crew.config.ts`;
}

function isBuiltInModelName(value: string): value is (typeof BUILT_IN_MODEL_NAMES)[number] {
  return value === "claude" || value === "codex";
}

function format(check: Check): string {
  let tag: string;
  if (check.ok) {
    tag = "[ok] ";
  } else if (check.required) {
    tag = "[--] ";
  } else {
    tag = "[? ] ";
  }
  /* v8 ignore next @preserve -- hints are always non-empty when set */
  const hint = check.hint !== undefined && check.hint.length > 0 ? `  — ${check.hint}` : "";
  return `${tag}${check.name}${hint}`;
}

export async function doctor(): Promise<boolean> {
  writeOutput("groundcrew doctor");
  writeOutput("=================");

  let config: ResolvedConfig;
  try {
    const { config: loadedConfig, source } = await loadConfigWithSource();
    config = loadedConfig;
    const sourceLabel = CONFIG_SOURCE_LABELS[source.kind];
    writeOutput(`[ok] config loaded — ${source.filepath} (${sourceLabel})`);
  } catch (error) {
    writeOutput(`[--] config: ${errorMessage(error)}`);
    return false;
  }

  let host: HostCapabilities;
  try {
    host = await detectHostCapabilities();
  } catch (error) {
    writeOutput(`[--] host: ${errorMessage(error)}`);
    return false;
  }
  const resolvedRunner = resolveLocalRunner(config.local.runner, host);
  const localCapability = localCapabilityCheck(host, resolvedRunner);
  reportLocalCapability({
    check: localCapability,
    setting: config.local.runner,
    resolved: resolvedRunner,
  });

  const workspaceOutcome = resolveWorkspaceOutcome(config, host);
  reportWorkspaceKind(config, workspaceOutcome);

  const checks: Check[] = [
    await checkSourceProbe(config),
    await checkCmd("git", true, "https://git-scm.com/"),
    ...(await workspaceChecks(workspaceOutcome)),
    checkDir(config.workspace.projectDir, "workspace.projectDir"),
    ...(config.workspace.worktreeDir === undefined
      ? []
      : [checkDir(worktreeBaseDir(config), "workspace.worktreeDir")]),
    localCapability,
  ];

  const toolTargets = gatherToolTargets(config);
  for (const { token, hint } of toolTargets) {
    const required = localCapability.ok;
    // oxlint-disable-next-line no-await-in-loop -- doctor reports tools in deterministic order
    const check = await checkCmd(token, required, required ? hint : "required for local runs");
    checks.push(check);
  }

  const usageGatedModels = gatedModels(config);
  if (usageGatedModels.length > 0) {
    const codexbarPath = await which("codexbar");
    if (codexbarPath === undefined) {
      const modelList = usageGatedModels.map((name) => `\`${name}\``).join(", ");
      checks.push({
        name: "codexbar",
        ok: false,
        required: true,
        hint: `required for usage gating on ${modelList} — install codexbar, or set \`models.definitions.<name>.usage\` to disable gating`,
      });
    } else {
      checks.push({ name: "codexbar", ok: true, required: true, hint: codexbarPath });
    }
  }

  for (const check of checks) {
    if (check === localCapability) {
      continue;
    }
    writeOutput(format(check));
  }

  const failed = checks.filter((check) => !check.ok && check.required);
  writeOutput();
  if (failed.length > 0) {
    writeOutput(`${failed.length} required check(s) failed.`);
    return false;
  }
  writeOutput("All required checks passed.");
  return true;
}

function localCapabilityCheck(host: HostCapabilities, resolved: LocalRunner): Check {
  if (resolved === "safehouse") {
    const ok = host.isSafehouseSupported && host.hasSafehouse;
    return {
      name: "local runner (safehouse)",
      ok,
      required: false,
      hint: ok
        ? "ready"
        : "safehouse runner requires macOS with `safehouse` on PATH (install from https://agent-safehouse.dev/)",
    };
  }
  if (resolved === "sdx") {
    const ok = host.isSdxSupported && host.hasSbx;
    return {
      name: "local runner (sdx)",
      ok,
      required: false,
      hint: ok
        ? "ready"
        : "sdx runner requires `sbx` (Docker Sandboxes) on PATH (install from https://docs.docker.com/ai/sandboxes/)",
    };
  }
  if (resolved === "srt") {
    const missingLinuxDeps = host.isLinux
      ? [
          host.hasBubblewrap ? undefined : "bubblewrap",
          host.hasSocat ? undefined : "socat",
          host.hasRipgrep ? undefined : "ripgrep (rg)",
        ].filter((name): name is string => name !== undefined)
      : [];
    const ok = host.isSrtSupported && missingLinuxDeps.length === 0;
    return {
      name: "local runner (srt)",
      ok,
      required: false,
      hint: srtRunnerHint(ok, host.isSrtSupported, missingLinuxDeps),
    };
  }
  // resolved === "none"
  return {
    name: "local runner (none)",
    ok: true,
    required: false,
    hint: "WARNING: local.runner='none' — agent runs unsandboxed on the host. Only use this when you understand the implications.",
  };
}

function srtRunnerHint(
  ok: boolean,
  isSrtSupported: boolean,
  missingLinuxDeps: readonly string[],
): string {
  if (ok) {
    return "ready (beta: @anthropic-ai/sandbox-runtime is a research preview)";
  }
  if (!isSrtSupported) {
    return "srt runner requires macOS or Linux/WSL";
  }
  return `srt runner on Linux requires ${missingLinuxDeps.join(", ")} on PATH (Debian/Ubuntu: \`apt install bubblewrap socat ripgrep\`; on Ubuntu 24.04+ also \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\`)`;
}

function reportLocalCapability(arguments_: {
  check: Check;
  setting: LocalRunnerSetting;
  resolved: LocalRunner;
}): void {
  writeOutput();
  writeOutput("Local runner");
  writeOutput("------------");
  writeOutput(`requested: ${arguments_.setting} → resolved: ${arguments_.resolved}`);
  writeOutput(format(arguments_.check));
}

type WorkspaceOutcome =
  | { kind: "ok"; resolution: WorkspaceResolution }
  | { kind: "error"; requested: ResolvedConfig["workspaceKind"]; reason: string };

function resolveWorkspaceOutcome(config: ResolvedConfig, host: HostCapabilities): WorkspaceOutcome {
  try {
    return { kind: "ok", resolution: resolveWorkspaceKind({ config, host }) };
  } catch (error) {
    return { kind: "error", requested: config.workspaceKind, reason: errorMessage(error) };
  }
}

function reportWorkspaceKind(config: ResolvedConfig, outcome: WorkspaceOutcome): void {
  writeOutput();
  writeOutput("Workspace");
  writeOutput("---------");
  writeOutput(`requested: ${config.workspaceKind}`);
  if (outcome.kind === "ok") {
    const { requested, resolved, reason } = outcome.resolution;
    writeOutput(`[ok] requested=${requested}, resolved=${resolved} (${reason})`);
  } else {
    writeOutput(`[--] requested=${outcome.requested} — ${outcome.reason}`);
  }
}

async function workspaceChecks(outcome: WorkspaceOutcome): Promise<Check[]> {
  if (outcome.kind === "error") {
    return [{ name: "workspaceKind", ok: false, required: true, hint: outcome.reason }];
  }
  const { resolved } = outcome.resolution;
  return [await checkCmd(resolved, true, `install ${resolved} first`)];
}
