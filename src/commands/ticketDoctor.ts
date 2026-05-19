import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createBoardSource,
  fetchBlockersForTicket,
  fetchRawLinearIssue,
  resolveModelFor,
  resolveRepositoryFor,
  type Blocker,
  type GroundcrewIssue,
  type RawLinearIssue,
} from "../lib/boardSource.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { getUsageByModel, type UsageByModel } from "../lib/usage.ts";
import { getLinearClient, writeOutput } from "../lib/util.ts";
import { classifyBlockers } from "./eligibility.ts";

export type TicketDoctorVerdict =
  | { kind: "would-dispatch" }
  | { kind: "ineligible"; reason: string }
  | { kind: "unresolvable"; reason: string };

export interface TicketCheck {
  name: string;
  status: "ok" | "fail" | "skipped";
  detail?: string;
}

export interface TicketDoctorResult {
  ticket: string;
  title?: string;
  resolution: TicketCheck[];
  eligibility: TicketCheck[];
  verdict: TicketDoctorVerdict;
}

export interface TicketDoctorDependencies {
  config: ResolvedConfig;
  ticket: string;
  /**
   * Injected to keep `ticketDoctor` pure and easy to unit-test. Production
   * callers pass a closure that delegates to `fetchRawLinearIssue` with a
   * real `LinearClient`; tests pass a `vi.fn()` returning a fixture.
   */
  fetchRawIssue: (input: { ticket: string }) => Promise<RawLinearIssue>;
  fetchBlockersFor: (input: { ticket: string; uuid: string }) => Promise<readonly Blocker[]>;
  fetchUsage: () => Promise<UsageByModel>;
  countInProgress: () => Promise<number>;
}

interface ModelResolutionResult {
  resolvedModel: string;
  checks: TicketCheck[];
}

function buildModelChecks(raw: RawLinearIssue, config: ResolvedConfig): ModelResolutionResult {
  const modelResolution = resolveModelFor({ labels: raw.labels, config });
  const checks: TicketCheck[] = [];
  switch (modelResolution.kind) {
    case "no-label": {
      checks.push({
        name: "Has agent-* label",
        status: "fail",
        detail: "no agent-* label on this ticket",
      });
      checks.push({ name: "Model resolves from agent-* label", status: "skipped" });
      break;
    }
    case "agent-any": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: "agent-any (model picked at dispatch time)",
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `would resolve to "${config.models.default}" if no other model has more headroom`,
      });
      break;
    }
    case "matched": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.model}`,
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `model "${modelResolution.model}"`,
      });
      break;
    }
    case "disabled-fallback": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.requestedModel}`,
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "fail",
        detail: `requested model "${modelResolution.requestedModel}" is disabled — would fall back to "${modelResolution.fallbackModel}"`,
      });
      break;
    }
    /* v8 ignore next @preserve */
    default: {
      break;
    }
  }
  const resolvedModel =
    modelResolution.kind === "matched" ? modelResolution.model : config.models.default;
  return { resolvedModel, checks };
}

interface RepoResolutionResult {
  resolvedRepository: string;
  checks: TicketCheck[];
}

function buildRepoChecks(
  raw: RawLinearIssue,
  config: ResolvedConfig,
  ticket: string,
): RepoResolutionResult {
  const repositoryResolution = resolveRepositoryFor({
    description: raw.description,
    config,
    ticket,
  });
  const checks: TicketCheck[] = [];
  if (repositoryResolution.kind === "ok") {
    checks.push({
      name: "Description mentions known repo",
      status: "ok",
      detail: repositoryResolution.repository,
    });
    const repoDir = join(config.workspace.projectDir, repositoryResolution.repository);
    if (existsSync(repoDir)) {
      checks.push({
        name: "Resolved repo is cloned locally",
        status: "ok",
        detail: repoDir,
      });
    } else {
      checks.push({
        name: "Resolved repo is cloned locally",
        status: "fail",
        detail: `${repositoryResolution.repository} not found at ${repoDir} — run \`crew setup repos ${repositoryResolution.repository}\``,
      });
    }
  } else {
    checks.push({
      name: "Description mentions known repo",
      status: "fail",
      detail: `no entry from workspace.knownRepositories (${config.workspace.knownRepositories.join(", ")}) appears in description`,
    });
    checks.push({
      name: "Resolved repo is cloned locally",
      status: "skipped",
    });
  }
  // repositoryResolution.kind is "ok" only when the first check passed.
  /* v8 ignore else @preserve */
  const resolvedRepository =
    repositoryResolution.kind === "ok" ? repositoryResolution.repository : "";
  return { resolvedRepository, checks };
}

interface EligibilityCheckArguments {
  ticket: string;
  raw: RawLinearIssue;
  config: ResolvedConfig;
  resolvedRepository: string;
  resolvedModel: string;
  dependencies: TicketDoctorDependencies;
  eligibility: TicketCheck[];
}

async function runEligibilityChecks(arguments_: EligibilityCheckArguments): Promise<boolean> {
  const { ticket, raw, config, resolvedRepository, resolvedModel, dependencies, eligibility } =
    arguments_;

  const blockers = await dependencies.fetchBlockersFor({ ticket, uuid: raw.uuid });
  const groundcrewIssue: GroundcrewIssue = {
    id: ticket,
    uuid: raw.uuid,
    title: raw.title,
    status: raw.stateName,
    statusId: "",
    assignee: "",
    updatedAt: "",
    teamId: raw.teamId,
    repository: resolvedRepository,
    model: resolvedModel,
    blockers: [...blockers],
    hasMoreBlockers: false,
  };

  const blockerClassification = classifyBlockers(config, [groundcrewIssue]);
  const [firstSkip] = blockerClassification.skips;
  if (firstSkip !== undefined) {
    // firstSkip.blockers is always set for "blocked" and "blockers_paginated" skip reasons.
    /* v8 ignore next @preserve */
    const blockerIds = firstSkip.blockers ?? [];
    eligibility.push({
      name: "No active blockers",
      status: "fail",
      detail: blockerIds.join(", "),
    });
    return false;
  }
  eligibility.push({ name: "No active blockers", status: "ok" });

  const usage = await dependencies.fetchUsage();
  const sessionFraction = usage[resolvedModel]?.session ?? 0;
  const limitPercentage = config.orchestrator.sessionLimitPercentage;
  // Mirror the dispatcher rule: exhausted when `session * 100 > sessionLimitPercentage`.
  // "ok" is the negation: session * 100 <= sessionLimitPercentage.
  const usageOk = sessionFraction * 100 <= limitPercentage;
  const sessionPercent = (sessionFraction * 100).toFixed(0);
  eligibility.push({
    name: `Model "${resolvedModel}" usage under sessionLimitPercentage`,
    status: usageOk ? "ok" : "fail",
    detail: `${sessionPercent}% (limit ${limitPercentage}%)`,
  });

  const inProgress = await dependencies.countInProgress();
  const cap = config.orchestrator.maximumInProgress;
  const capOk = inProgress < cap;
  eligibility.push({
    name: "In-progress cap not hit",
    status: capOk ? "ok" : "fail",
    detail: `${inProgress}/${cap} used`,
  });

  return eligibility.every((check) => check.status === "ok");
}

const STATUS_TAG: Record<TicketCheck["status"], string> = {
  ok: "[ok]",
  fail: "[--]",
  skipped: "[--]",
};

function formatCheck(check: TicketCheck): string {
  const tag = STATUS_TAG[check.status];
  const detail = check.detail === undefined ? "" : ` (${check.detail})`;
  return `  ${tag} ${check.name}${detail}`;
}

function eligibilityLines(result: TicketDoctorResult): string[] {
  if (result.eligibility.length === 0) {
    const skipMessage =
      result.verdict.kind === "unresolvable"
        ? "  (skipped — ticket unresolved)"
        : "  (skipped — resolution checks failed)";
    return [skipMessage];
  }
  return result.eligibility.map(formatCheck);
}

export function renderTicketDoctorResult(result: TicketDoctorResult): string[] {
  const titlePart = result.title === undefined ? "" : ` (${result.title})`;
  const header = `groundcrew ticket doctor — ${result.ticket}${titlePart}`;
  const bar = "─".repeat(header.length);

  const verdictLine =
    result.verdict.kind === "would-dispatch"
      ? "→ would be dispatched on next tick"
      : `→ ineligible: ${result.verdict.reason}`;

  return [
    header,
    bar,
    "",
    "Resolution",
    ...result.resolution.map(formatCheck),
    "",
    "Eligibility",
    ...eligibilityLines(result),
    "",
    verdictLine,
  ];
}

export async function ticketDoctor(
  dependencies: TicketDoctorDependencies,
): Promise<TicketDoctorResult> {
  const ticket = dependencies.ticket.toUpperCase();
  const resolution: TicketCheck[] = [];
  const eligibility: TicketCheck[] = [];
  let raw: RawLinearIssue;
  try {
    raw = await dependencies.fetchRawIssue({ ticket });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resolution.push({ name: "Ticket exists in Linear", status: "fail", detail: message });
    return {
      ticket,
      resolution,
      eligibility,
      verdict: { kind: "unresolvable", reason: message },
    };
  }

  const { config } = dependencies;

  resolution.push({ name: "Ticket exists in Linear", status: "ok", detail: `"${raw.title}"` });

  // Status check
  const todoState = config.linear.statuses.todo;
  if (raw.stateName === todoState) {
    resolution.push({ name: "Status is Todo", status: "ok" });
  } else {
    resolution.push({
      name: "Status is Todo",
      status: "fail",
      detail: `current: ${raw.stateName}`,
    });
  }

  // Label + model checks
  const { resolvedModel, checks: modelChecks } = buildModelChecks(raw, config);
  resolution.push(...modelChecks);

  // Repo checks
  const { resolvedRepository, checks: repoChecks } = buildRepoChecks(raw, config, ticket);
  resolution.push(...repoChecks);

  const firstResolutionFail = resolution.find((check) => check.status === "fail");
  if (firstResolutionFail !== undefined) {
    return {
      ticket,
      title: raw.title,
      resolution,
      eligibility,
      verdict: { kind: "ineligible", reason: firstResolutionFail.name },
    };
  }

  // All resolution checks passed (or were skipped). Run eligibility checks.
  const allEligibilityOk = await runEligibilityChecks({
    ticket,
    raw,
    config,
    resolvedRepository,
    resolvedModel,
    dependencies,
    eligibility,
  });
  if (!allEligibilityOk) {
    const firstEligibilityFail = eligibility.find((check) => check.status === "fail");
    // firstEligibilityFail is always defined when allEligibilityOk is false; fallback is defensive.
    /* v8 ignore next @preserve */
    const reason = firstEligibilityFail?.name ?? "eligibility check failed";
    return {
      ticket,
      title: raw.title,
      resolution,
      eligibility,
      verdict: { kind: "ineligible", reason },
    };
  }
  return {
    ticket,
    title: raw.title,
    resolution,
    eligibility,
    verdict: { kind: "would-dispatch" },
  };
}

export async function ticketDoctorCli(argv: string[]): Promise<void> {
  const [ticket, ...extraArgs] = argv;
  if (ticket === undefined || ticket.length === 0 || ticket.startsWith("-")) {
    throw new Error("Usage: crew ticket doctor <ticket>");
  }
  /* v8 ignore else @preserve */
  if (extraArgs.length > 0) {
    throw new Error(`crew ticket doctor: unexpected arguments: ${extraArgs.join(" ")}`);
  }
  /* v8 ignore start @preserve */
  const config = await loadConfig();
  const client = getLinearClient();
  const boardSource = createBoardSource({ config, client });

  const result = await ticketDoctor({
    config,
    ticket,
    fetchRawIssue: async ({ ticket: t }) => await fetchRawLinearIssue({ client, ticket: t }),
    fetchBlockersFor: async ({ ticket: t, uuid }) =>
      await fetchBlockersForTicket({ client, ticket: t, uuid }),
    fetchUsage: async () => await getUsageByModel(config),
    countInProgress: async () => {
      const board = await boardSource.fetch();
      return board.issues.filter((issue) => issue.status === config.linear.statuses.inProgress)
        .length;
    },
  });

  for (const line of renderTicketDoctorResult(result)) {
    writeOutput(line);
  }
  if (result.verdict.kind !== "would-dispatch") {
    process.exitCode = 1;
  }
  /* v8 ignore stop @preserve */
}
