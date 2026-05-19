import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  fetchBlockersForTicket,
  fetchInProgressIssueCount,
  fetchRawLinearIssue,
  resolveModelFor,
  resolveRepositoryFor,
  type Blocker,
  type GroundcrewIssue,
  type RawLinearIssue,
} from "../lib/boardSource.ts";
import { AGENT_ANY_MODEL, loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { getUsageByModel, type UsageByModel } from "../lib/usage.ts";
import { getLinearClient, writeOutput } from "../lib/util.ts";
import {
  classifyBlockers,
  classifyUsageExhaustion,
  pickBestModel,
  type ModelUsageExhaustion,
} from "./eligibility.ts";

export type TicketDoctorVerdict =
  | { kind: "would-dispatch" }
  | { kind: "ineligible"; reason: string }
  | { kind: "unresolvable"; reason: string };

export interface TicketCheck {
  name: string;
  status: "ok" | "fail" | "skipped";
  detail?: string;
  failureSummary?: string;
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
        failureSummary: "ticket has no agent-* label",
      });
      checks.push({ name: "Model resolves from agent-* label", status: "skipped" });
      break;
    }
    case "agent-any": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: "agent-any",
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `model picked at dispatch time; defaults to "${config.models.default}" when usage ties`,
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
        status: "ok",
        detail: `agent-${modelResolution.requestedModel} disabled; falling back to model "${modelResolution.fallbackModel}"`,
      });
      break;
    }
    /* v8 ignore next @preserve */
    default: {
      break;
    }
  }
  let resolvedModel = config.models.default;
  if (modelResolution.kind === "matched") {
    resolvedModel = modelResolution.model;
  } else if (modelResolution.kind === "agent-any") {
    resolvedModel = AGENT_ANY_MODEL;
  } else if (modelResolution.kind === "disabled-fallback") {
    resolvedModel = modelResolution.fallbackModel;
  }
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
        failureSummary: `resolved repo ${repositoryResolution.repository} is not cloned locally`,
      });
    }
  } else {
    checks.push({
      name: "Description mentions known repo",
      status: "fail",
      detail: `no entry from workspace.knownRepositories (${config.workspace.knownRepositories.join(", ")}) appears in description`,
      failureSummary: "description does not mention a known repo",
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
    hasMoreBlockers: raw.hasMoreBlockers,
  };

  const blockerClassification = classifyBlockers(config, [groundcrewIssue]);
  const [firstSkip] = blockerClassification.skips;
  if (firstSkip !== undefined) {
    if (firstSkip.eventReason === "blockers_paginated") {
      eligibility.push({
        name: "No active blockers",
        status: "fail",
        detail: "blockers exceeded the v1 relation page size",
        failureSummary: "blockers exceeded the v1 relation page size",
      });
      return false;
    }
    // firstSkip.blockers is always set for "blocked" and "blockers_paginated" skip reasons.
    /* v8 ignore next @preserve */
    const blockerIds = firstSkip.blockers ?? [];
    eligibility.push({
      name: "No active blockers",
      status: "fail",
      detail: blockerIds.join(", "),
      failureSummary: `blocked by ${blockerIds.join(", ")}`,
    });
    return false;
  }
  eligibility.push({ name: "No active blockers", status: "ok" });

  const usage = await dependencies.fetchUsage();
  const usageExhaustion = classifyUsageExhaustion(config, usage);
  const exhausted = new Set(usageExhaustion.map((exhaustion) => exhaustion.model));
  let model = resolvedModel;
  let resolvedFromAny = "";
  if (model === AGENT_ANY_MODEL) {
    const picked = pickBestModel(config, usage, exhausted);
    if (picked === undefined) {
      eligibility.push({
        name: "Model usage under sessionLimitPercentage",
        status: "fail",
        detail: "agent-any but no model has available capacity",
        failureSummary: "agent-any has no model with available capacity",
      });
      return false;
    }
    model = picked;
    resolvedFromAny = `; agent-any resolved to model "${picked}"`;
  }

  const exhaustedUsage = usageExhaustion.find((exhaustion) => exhaustion.model === model);
  eligibility.push(
    exhaustedUsage === undefined
      ? modelUsageOkCheck({ config, model, usage, resolvedFromAny })
      : usageExhaustionCheck(exhaustedUsage),
  );

  const inProgress = await dependencies.countInProgress();
  const cap = config.orchestrator.maximumInProgress;
  const capOk = inProgress < cap;
  const capCheck: TicketCheck = {
    name: "In-progress cap not hit",
    status: capOk ? "ok" : "fail",
    detail: `${inProgress}/${cap} used`,
  };
  if (!capOk) {
    capCheck.failureSummary = `in-progress cap is full (${inProgress}/${cap} used)`;
  }
  eligibility.push(capCheck);

  return eligibility.every((check) => check.status === "ok");
}

function modelUsageOkCheck(arguments_: {
  config: ResolvedConfig;
  model: string;
  usage: UsageByModel;
  resolvedFromAny: string;
}): TicketCheck {
  const { config, model, usage, resolvedFromAny } = arguments_;
  const sessionPercent = ((usage[model]?.session ?? 0) * 100).toFixed(0);
  return {
    name: `Model "${model}" usage under sessionLimitPercentage`,
    status: "ok",
    detail: `${sessionPercent}% (limit ${config.orchestrator.sessionLimitPercentage}%)${resolvedFromAny}`,
  };
}

function usageExhaustionCheck(exhaustion: ModelUsageExhaustion): TicketCheck {
  if (exhaustion.kind === "session") {
    return {
      name: `Model "${exhaustion.model}" usage under sessionLimitPercentage`,
      status: "fail",
      detail: `${exhaustion.usedPercentage.toFixed(0)}% (limit ${exhaustion.limitPercentage}%)`,
      failureSummary: `${exhaustion.model} session usage ${exhaustion.usedPercentage.toFixed(0)}% over ${exhaustion.limitPercentage}% limit`,
    };
  }
  return {
    name: `Model "${exhaustion.model}" weekly usage within paced budget`,
    status: "fail",
    detail: `${exhaustion.usedPercentage.toFixed(1)}% (paced budget ${exhaustion.allowedPercentage.toFixed(1)}%, resets in ${exhaustion.resetMinutes}m)`,
    failureSummary: `${exhaustion.model} weekly usage ${exhaustion.usedPercentage.toFixed(1)}% over ${exhaustion.allowedPercentage.toFixed(1)}% paced budget`,
  };
}

const STATUS_TAG: Record<TicketCheck["status"], string> = {
  ok: "[ok]",
  fail: "[--]",
  skipped: "[? ]",
};

function formatCheck(check: TicketCheck): string {
  const tag = STATUS_TAG[check.status];
  const detail = check.detail === undefined ? "" : ` (${check.detail})`;
  return `  ${tag} ${check.name}${detail}`;
}

function formatVerdict(verdict: TicketDoctorVerdict): string {
  switch (verdict.kind) {
    case "would-dispatch": {
      return "→ would be dispatched on next tick";
    }
    case "unresolvable": {
      return `→ unresolvable: ${verdict.reason}`;
    }
    case "ineligible": {
      return `→ ineligible: ${verdict.reason}`;
    }
    /* v8 ignore next 3 @preserve -- exhaustive over TicketDoctorVerdict.kind */
    default: {
      return `→ ${(verdict satisfies never as TicketDoctorVerdict).kind}`;
    }
  }
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
  const header = `groundcrew doctor --ticket ${result.ticket}${titlePart}`;
  const bar = "─".repeat(header.length);

  const verdictLine = formatVerdict(result.verdict);

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
      failureSummary: `status is ${raw.stateName} (need ${todoState})`,
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
    // failureSummary is always set for all resolution fail paths; .name fallback is defensive.
    /* v8 ignore next @preserve */
    const resolutionReason = firstResolutionFail.failureSummary ?? firstResolutionFail.name;
    return {
      ticket,
      title: raw.title,
      resolution,
      eligibility,
      verdict: { kind: "ineligible", reason: resolutionReason },
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
    const reason =
      firstEligibilityFail?.failureSummary ??
      firstEligibilityFail?.name ??
      "eligibility check failed";
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
    throw new Error("Usage: crew doctor --ticket <ticket>");
  }
  /* v8 ignore else @preserve */
  if (extraArgs.length > 0) {
    throw new Error(`crew doctor --ticket: unexpected arguments: ${extraArgs.join(" ")}`);
  }
  /* v8 ignore start @preserve */
  const ok = await runTicketDoctor(ticket);
  if (!ok) {
    process.exitCode = 1;
  }
  /* v8 ignore stop @preserve */
}

export async function runTicketDoctor(ticket: string): Promise<boolean> {
  const config = await loadConfig();
  let client: ReturnType<typeof getLinearClient> | undefined;
  const linearClient = (): ReturnType<typeof getLinearClient> => {
    client ??= getLinearClient();
    return client;
  };

  const result = await ticketDoctor({
    config,
    ticket,
    fetchRawIssue: async ({ ticket: t }) =>
      await fetchRawLinearIssue({ client: linearClient(), ticket: t }),
    fetchBlockersFor: async ({ ticket: t, uuid }) =>
      await fetchBlockersForTicket({ client: linearClient(), ticket: t, uuid }),
    fetchUsage: async () => await getUsageByModel(config),
    countInProgress: async () =>
      await fetchInProgressIssueCount({ client: linearClient(), config }),
  });

  for (const line of renderTicketDoctorResult(result)) {
    writeOutput(line);
  }
  return result.verdict.kind === "would-dispatch";
}
