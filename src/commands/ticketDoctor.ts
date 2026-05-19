import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveModelFor, resolveRepositoryFor, type RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";

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
  const statusOk = raw.stateName === todoState;
  if (statusOk) {
    resolution.push({ name: "Status is Todo", status: "ok" });
  } else {
    resolution.push({
      name: "Status is Todo",
      status: "fail",
      detail: `current: ${raw.stateName}`,
    });
  }

  // Label + model checks — branch on resolveModelFor's discriminator
  const modelResolution = resolveModelFor({ labels: raw.labels, config });
  switch (modelResolution.kind) {
    case "no-label": {
      resolution.push({
        name: "Has agent-* label",
        status: "fail",
        detail: "no agent-* label on this ticket",
      });
      resolution.push({ name: "Model resolves from agent-* label", status: "skipped" });
      break;
    }
    case "agent-any": {
      resolution.push({
        name: "Has agent-* label",
        status: "ok",
        detail: "agent-any (model picked at dispatch time)",
      });
      resolution.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `would resolve to "${config.models.default}" if no other model has more headroom`,
      });
      break;
    }
    case "matched": {
      resolution.push({
        name: "Has agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.model}`,
      });
      resolution.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `model "${modelResolution.model}"`,
      });
      break;
    }
    case "disabled-fallback": {
      resolution.push({
        name: "Has agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.requestedModel}`,
      });
      resolution.push({
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

  // Repo check
  const repositoryResolution = resolveRepositoryFor({
    description: raw.description,
    config,
    ticket,
  });
  if (repositoryResolution.kind === "ok") {
    resolution.push({
      name: "Description mentions known repo",
      status: "ok",
      detail: repositoryResolution.repository,
    });
  } else {
    resolution.push({
      name: "Description mentions known repo",
      status: "fail",
      detail: `no entry from workspace.knownRepositories (${config.workspace.knownRepositories.join(", ")}) appears in description`,
    });
  }

  // Repo cloned-locally check
  if (repositoryResolution.kind === "ok") {
    const repoDir = join(config.workspace.projectDir, repositoryResolution.repository);
    if (existsSync(repoDir)) {
      resolution.push({
        name: "Resolved repo is cloned locally",
        status: "ok",
        detail: repoDir,
      });
    } else {
      resolution.push({
        name: "Resolved repo is cloned locally",
        status: "fail",
        detail: `${repositoryResolution.repository} not found at ${repoDir} — run \`crew setup repos ${repositoryResolution.repository}\``,
      });
    }
  } else {
    resolution.push({
      name: "Resolved repo is cloned locally",
      status: "skipped",
    });
  }

  // Verdict: any resolution fail → ineligible with first-fail name; otherwise placeholder
  const firstFail = resolution.find((check) => check.status === "fail");
  if (firstFail !== undefined) {
    return {
      ticket,
      title: raw.title,
      resolution,
      eligibility,
      verdict: { kind: "ineligible", reason: firstFail.name },
    };
  }
  return {
    ticket,
    title: raw.title,
    resolution,
    eligibility,
    verdict: { kind: "ineligible", reason: "eligibility checks not implemented yet" },
  };
}
