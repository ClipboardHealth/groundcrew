/**
 * `crew doctor`: verify the host end to end (design §7.1, contracts §7). Required
 * tools on PATH, config parses and validates, every configured source checks
 * clean (protocol/prerequisites/secrets/live round-trip), agent profiles resolve,
 * no credential-looking strings in config, and reconcile finds no orphans. Exit
 * 0 = ready to `crew start`; exit 1 with each failing check named (SURFACE-02).
 * Doctor tolerates a broken config: it reports the failure instead of crashing.
 */
import * as fs from "node:fs";

import { isSandboxRunnerAvailable } from "../../sandbox/index.js";
import {
  type CheckResult,
  checkAgents,
  checkBaseDirectory,
  checkCredentialsInConfig,
  checkRequiredTools,
  checkSource,
} from "../checks.js";
import { type ContextEnvironment, type Context, loadContext } from "../context.js";
import { dispatchReconcile } from "../dispatchAdapter.js";
import { onPath } from "../detect.js";
import { listForeignRunRecords, runsDirectory } from "../../run/index.js";
import type { Io } from "../io.js";
import { renderChecks } from "../render/doctor.js";

export async function runDoctor(input: {
  readonly environment: ContextEnvironment;
  readonly cwd: string;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly io: Io;
}): Promise<number> {
  const checks: CheckResult[] = [];

  let context: Context | undefined;
  try {
    context = loadContext({
      environment: input.environment,
      cwd: input.cwd,
      verbose: input.verbose,
    });
    checks.push(ok(`config valid (${context.configPath})`));
  } catch (error) {
    checks.push(bad("config parses and validates", messageOf(error)));
  }

  if (context === undefined) {
    checks.push(...(await envToolChecks(input.environment)));
    return report({ checks, json: input.json, io: input.io });
  }

  checks.push(...(await checkRequiredTools(context)), checkBaseDirectory(context));
  if (context.sandboxDisabled()) {
    checks.push(ok("sandbox: OFF (GROUNDCREW_SANDBOX=off — agents and sources run unwrapped)"));
  }

  for (const resolved of context.resolvedSources()) {
    // eslint-disable-next-line no-await-in-loop -- sources are checked in order for stable output
    checks.push(...(await checkSource({ context, resolved })));
  }

  checks.push(...checkAgents(context), credentialCheck(context), await reconcileCheck(context));

  const foreignNote = await foreignStateNote(context);
  if (foreignNote !== undefined) {
    checks.push(foreignNote);
  }

  return report({ checks, json: input.json, io: input.io });
}

/**
 * A note (never a failure) when the runs directory holds files v2 does not
 * recognize — most often live v1 state. v2 ignores them; this just says so, so
 * the operator is not surprised and doctor still exits 0 (Bug 3, DEVOP dogfood).
 */
async function foreignStateNote(context: Context): Promise<CheckResult | undefined> {
  const foreign = await listForeignRunRecords({ stateRoot: context.stateRoot });
  if (foreign.length === 0) {
    return undefined;
  }

  const directory = runsDirectory({ stateRoot: context.stateRoot });
  return {
    label: `${String(foreign.length)} unrecognized state file(s) in ${directory} (v1 state? v2 ignores them)`,
    ok: true,
    detail: undefined,
    source: undefined,
    note: true,
  };
}

function credentialCheck(context: Context): CheckResult {
  const raw = fs.existsSync(context.configPath)
    ? fs.readFileSync(context.configPath, "utf8")
    : "";
  return checkCredentialsInConfig(raw);
}

async function reconcileCheck(context: Context): Promise<CheckResult> {
  const reconcileReport = await dispatchReconcile({ context });
  const problems = [...reconcileReport.orphanedRunning, ...reconcileReport.straySessions];
  return problems.length === 0
    ? ok("reconcile finds no orphans")
    : bad("reconcile finds no orphans", `orphaned/stray: ${problems.join(", ")}`);
}

async function envToolChecks(environment: ContextEnvironment): Promise<CheckResult[]> {
  const pathValue = environment.PATH ?? "";
  const results: CheckResult[] = [
    onPath({ name: "git", pathValue })
      ? ok("git on PATH")
      : bad("git on PATH", "git was not found on PATH"),
  ];
  const presenter = ["cmux", "tmux", "zellij"].find((name) => onPath({ name, pathValue }));
  results.push(
    presenter === undefined
      ? bad("a session presenter on PATH", "none of cmux, tmux, zellij were found")
      : ok(`session presenter "${presenter}" on PATH`),
    (await isSandboxRunnerAvailable())
      ? ok("srt sandbox runner available")
      : bad("srt sandbox runner available", "the srt runner is not usable on this host"),
  );
  return results;
}

function report(input: {
  readonly checks: readonly CheckResult[];
  readonly json: boolean;
  readonly io: Io;
}): number {
  if (input.json) {
    input.io.out(JSON.stringify(input.checks, undefined, 2));
  } else {
    input.io.out(renderChecks({ title: "crew doctor", checks: input.checks }));
  }

  return input.checks.every((check) => check.ok) ? 0 : 1;
}

function ok(label: string): CheckResult {
  return { label, ok: true, detail: undefined, source: undefined };
}

function bad(label: string, detail: string): CheckResult {
  return { label, ok: false, detail, source: undefined };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
