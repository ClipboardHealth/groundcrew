import path from "node:path";

import {
  type AgentTrustAgent,
  type AgentTrustEntry,
  type DeleteAgentWorkspaceTrustResult,
  isMissingAgentTrustEntry,
} from "./agentWorkspaceTrustAdmin.ts";
import { failMark, okMark, styleDim, styleWarning } from "./util.ts";

const AGENT_ORDER: readonly AgentTrustAgent[] = ["cursor", "claude", "codex"];
const UNPARSEABLE_CURSOR_DETAIL = "trusted (unparseable marker)";

export interface FormatAgentTrustListOptions {
  homeDir: string;
  missingOnly?: boolean;
}

export interface FormatTrustActionResultsOptions {
  homeDir: string;
  action: "delete" | "prune";
}

export function shortenTrustPath(workspacePath: string, homeDir: string): string {
  const resolved = path.resolve(workspacePath);
  const home = path.resolve(homeDir);
  if (resolved === home) {
    return "~";
  }
  const homePrefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (resolved.startsWith(homePrefix)) {
    return `~${path.sep}${resolved.slice(homePrefix.length)}`;
  }
  return resolved;
}

function sectionBlock(title: string, lines: readonly string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return [title, "-".repeat(title.length), ...lines, ""];
}

function formatListEntryLine(entry: AgentTrustEntry, homeDir: string): string {
  const shortPath = shortenTrustPath(entry.workspacePath, homeDir);
  if (entry.detail === UNPARSEABLE_CURSOR_DETAIL) {
    return `  ${styleWarning("⚠")}  ${shortPath}  ${styleDim("unparseable marker")}`;
  }
  if (isMissingAgentTrustEntry(entry)) {
    return `  ${failMark()}  ${shortPath}  ${styleDim("[missing]")}`;
  }
  return `  ${okMark()}  ${shortPath}`;
}

function countMissing(entries: readonly AgentTrustEntry[]): number {
  return entries.filter(isMissingAgentTrustEntry).length;
}

function agentSectionTitle(agent: AgentTrustAgent, count: number): string {
  const label = agent.charAt(0).toUpperCase() + agent.slice(1);
  return `${label} (${String(count)})`;
}

export function formatAgentTrustList(
  entries: readonly AgentTrustEntry[],
  options: FormatAgentTrustListOptions,
): string {
  if (entries.length === 0) {
    if (options.missingOnly === true) {
      return "No stale workspace trust entries.";
    }
    return "No workspace trust entries found.";
  }

  const missingCount = countMissing(entries);
  const header =
    options.missingOnly === true
      ? `Stale workspace trust (${String(entries.length)} ${entries.length === 1 ? "entry" : "entries"})`
      : missingCount > 0
        ? `Workspace trust (${String(entries.length)} ${entries.length === 1 ? "entry" : "entries"} · ${String(missingCount)} missing)`
        : `Workspace trust (${String(entries.length)} ${entries.length === 1 ? "entry" : "entries"})`;

  const lines: string[] = [header, ""];
  for (const agent of AGENT_ORDER) {
    const agentEntries = entries.filter((entry) => entry.agent === agent);
    lines.push(
      ...sectionBlock(
        agentSectionTitle(agent, agentEntries.length),
        agentEntries.map((entry) => formatListEntryLine(entry, options.homeDir)),
      ),
    );
  }

  return lines.join("\n").replace(/\n+$/u, "");
}

export function formatTrustActionResults(
  results: readonly DeleteAgentWorkspaceTrustResult[],
  options: FormatTrustActionResultsOptions,
): string {
  if (results.length === 0) {
    return options.action === "prune"
      ? "No stale workspace trust entries."
      : "No matching workspace trust entries.";
  }

  const removed = results.filter((result) => result.deleted).length;
  const failed = results.length - removed;
  const removedNoun = removed === 1 ? "entry" : "entries";
  const header =
    options.action === "prune"
      ? `Pruned ${String(removed)} stale ${removedNoun}`
      : `Removed ${String(removed)} ${removedNoun}`;

  const lines: string[] = [header, ""];
  for (const result of results) {
    const shortPath = shortenTrustPath(result.workspacePath, options.homeDir);
    const mark = result.deleted ? okMark() : failMark();
    lines.push(`  ${mark}  ${result.agent}  ${shortPath}`);
  }

  if (failed > 0) {
    lines.push("", `Summary: ${String(removed)} removed · ${String(failed)} failed`);
  }

  return lines.join("\n");
}
