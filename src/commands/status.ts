import { readFileSync } from "node:fs";

import { fetchRawLinearIssue } from "../lib/boardSource.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import {
  errorMessage,
  getLinearClient,
  withLogOutputSuppressed,
  writeOutput,
} from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeDirtiness, worktrees } from "../lib/worktrees.ts";

export interface StatusOptions {
  ticket?: string;
}

const RECENT_LOG_LINE_COUNT = 10;

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function ticketLinePattern(ticket: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(ticket)}([^a-z0-9]|$)`, "i");
}

function parseArguments(argv: string[]): StatusOptions {
  const [ticket, ...extras] = argv;
  if (extras.length > 0 || ticket?.length === 0 || ticket?.startsWith("-") === true) {
    throw new Error("Usage: crew status [<ticket>]");
  }
  return ticket === undefined ? {} : { ticket: ticket.toLowerCase() };
}

function writeSection(title: string): void {
  writeOutput();
  writeOutput(title);
  writeOutput("-".repeat(title.length));
}

function writeConfigSnapshot(config: ResolvedConfig): void {
  writeSection("Config snapshot");
  writeOutput(`projectDir: ${config.workspace.projectDir}`);
  writeOutput(`repositories: ${config.workspace.knownRepositories.join(", ")}`);
  writeOutput(`git: remote=${config.git.remote}; defaultBranch=${config.git.defaultBranch}`);
  writeOutput(`workspaceKind: ${config.workspaceKind}`);
  writeOutput(`local.runner: ${config.local.runner}`);
  writeOutput(
    `models: default=${config.models.default}; enabled=${Object.keys(config.models.definitions).join(", ")}`,
  );
  writeOutput(`logFile: ${config.logging.file}`);
}

function formatDirtiness(dirtiness: WorktreeDirtiness): string {
  if (dirtiness.kind === "dirty") {
    return `dirty (${dirtiness.modified} modified, ${dirtiness.untracked} untracked)`;
  }
  return dirtiness.kind;
}

async function writeTicketWorktrees(config: ResolvedConfig, ticket: string): Promise<void> {
  writeSection("Worktree state");
  const entries = worktrees.findByTicket(config, ticket);
  if (entries.length === 0) {
    writeOutput("(none)");
    return;
  }
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- status output is easier to read in worktree order.
    const dirtiness = await worktrees.probeWorkingTree({ worktreeDir: entry.dir });
    writeOutput(`- ${entry.repository} ${entry.kind}`);
    writeOutput(`  ticket: ${entry.ticket}`);
    writeOutput(`  branch: ${entry.branchName}`);
    writeOutput(`  dir: ${entry.dir}`);
    writeOutput(`  git: ${formatDirtiness(dirtiness)}`);
  }
}

function workspaceProbeUnavailableLine(
  probe: Extract<WorkspaceProbe, { kind: "unavailable" }>,
): string {
  return probe.error === undefined
    ? "Workspace probe unavailable"
    : `Workspace probe unavailable: ${errorMessage(probe.error)}`;
}

function writeTicketWorkspace(probe: WorkspaceProbe, ticket: string): void {
  writeSection("Workspace probe");
  if (probe.kind === "unavailable") {
    writeOutput(workspaceProbeUnavailableLine(probe));
    return;
  }
  writeOutput(`live: ${probe.names.has(ticket) ? "yes" : "no"}`);
}

function formatRunState(state: RunState | undefined): string {
  if (state === undefined) {
    return "(none)";
  }
  const summary = `${state.state}; model=${state.model}; updated=${state.updatedAt}; resumes=${state.resumeCount}`;
  const detail = state.reason ?? state.detail;
  return detail === undefined ? summary : `${summary}; ${detail}`;
}

function recentTicketLogLines(config: ResolvedConfig, ticket: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(config.logging.file, "utf8");
  } catch {
    return [];
  }
  const pattern = ticketLinePattern(ticket);
  return raw
    .split("\n")
    .filter((line) => pattern.test(line))
    .slice(-RECENT_LOG_LINE_COUNT);
}

async function linearStatus(ticket: string): Promise<string> {
  try {
    const issue = await fetchRawLinearIssue({ client: getLinearClient(), ticket });
    return `${issue.stateName} (state.type=${issue.stateType ?? "unknown"}) — ${issue.title}`;
  } catch (error) {
    return `unavailable: ${errorMessage(error)}`;
  }
}

async function writeTicketStatus(config: ResolvedConfig, rawTicket: string): Promise<void> {
  const ticket = rawTicket.toLowerCase();
  const displayTicket = ticket.toUpperCase();
  writeOutput(`groundcrew status ${displayTicket}`);
  writeOutput("=".repeat(`groundcrew status ${displayTicket}`.length));
  writeOutput(`ticket: ${ticket}`);

  writeConfigSnapshot(config);
  await writeTicketWorktrees(config, ticket);
  const workspaceProbe = await withLogOutputSuppressed(async () => await workspaces.probe(config));
  writeTicketWorkspace(workspaceProbe, ticket);

  writeSection("Run state");
  writeOutput(formatRunState(readRunState(config, ticket)));

  writeSection("Recent logs");
  const logLines = recentTicketLogLines(config, ticket);
  writeOutput(logLines.length === 0 ? "(none)" : logLines.join("\n"));

  writeSection("Last Linear status");
  writeOutput(await linearStatus(ticket));
}

function workspacePresence(probe: WorkspaceProbe, ticket: string): string {
  if (probe.kind === "unavailable") {
    return "unknown";
  }
  return probe.names.has(ticket) ? "yes" : "no";
}

function writeInventoryWorktrees(config: ResolvedConfig, probe: WorkspaceProbe): void {
  writeSection("Worktrees");
  const entries = worktrees
    .list(config)
    .toSorted((left, right) => left.ticket.localeCompare(right.ticket));
  if (entries.length === 0) {
    writeOutput("(none)");
    return;
  }
  const runStates = new Map<string, RunState | undefined>();
  for (const entry of entries) {
    if (!runStates.has(entry.ticket)) {
      runStates.set(entry.ticket, readRunState(config, entry.ticket));
    }
    const runState = runStates.get(entry.ticket);
    writeOutput(
      `${entry.ticket}  ${entry.repository}  ${entry.kind}  workspace=${workspacePresence(probe, entry.ticket)}  run=${runState?.state ?? "none"}`,
    );
    writeOutput(`  ${entry.branchName}  ${entry.dir}`);
  }
}

function writeInventoryWorkspaces(probe: WorkspaceProbe): void {
  writeSection("Live workspaces");
  if (probe.kind === "unavailable") {
    writeOutput(workspaceProbeUnavailableLine(probe));
    return;
  }
  const names = [...probe.names].toSorted();
  writeOutput(names.length === 0 ? "(none)" : names.join("\n"));
}

async function writeInventoryStatus(config: ResolvedConfig): Promise<void> {
  writeOutput("groundcrew status");
  writeOutput("=================");
  const probe = await withLogOutputSuppressed(async () => await workspaces.probe(config));
  writeInventoryWorktrees(config, probe);
  writeInventoryWorkspaces(probe);
}

export async function status(config: ResolvedConfig, options: StatusOptions = {}): Promise<void> {
  const ticket = options.ticket?.trim();
  if (ticket === undefined) {
    await writeInventoryStatus(config);
    return;
  }
  if (ticket.length === 0 || ticket.startsWith("-")) {
    throw new Error("ticket must be a non-empty value");
  }
  await writeTicketStatus(config, ticket);
}

export async function statusCli(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  const config = await loadConfig();
  await status(config, options);
}
