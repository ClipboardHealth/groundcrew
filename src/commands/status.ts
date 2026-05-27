import { readFileSync } from "node:fs";

import { getLinearClient } from "../lib/adapters/linear/client.ts";
import { fetchRawLinearIssue } from "../lib/adapters/linear/fetch.ts";
import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import {
  type GroundcrewIssue,
  isGroundcrewIssue,
  type Issue as SourceIssue,
  naturalIdFromCanonical,
} from "../lib/ticketSource.ts";
import { errorMessage, withLogOutputSuppressed, writeOutput } from "../lib/util.ts";
import { type WorkspaceAccessHint, type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
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
    const dirtiness = await worktrees.probeWorkingTree({
      worktreeDir: entry.dir,
    });
    // oxlint-disable-next-line no-await-in-loop -- one gh lookup per worktree is acceptable; multi-worktree-per-ticket is rare.
    const prs = await findPullRequestsForBranch({
      repository: entry.repository,
      branchName: entry.branchName,
    });
    writeOutput(`- ${entry.repository} ${entry.kind}`);
    writeOutput(`  ticket: ${entry.ticket}`);
    writeOutput(`  branch: ${entry.branchName}`);
    writeOutput(`  dir: ${entry.dir}`);
    writeOutput(`  git: ${formatDirtiness(dirtiness)}`);
    if (prs.length > 0) {
      writeOutput(`  pr: ${formatPullRequests(prs)}`);
    }
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
    const issue = await fetchRawLinearIssue({
      client: getLinearClient(),
      ticket,
    });
    // `stateType` is "" when Linear returned a stateless ticket; surface that
    // as "unknown" rather than an empty token.
    return `${issue.stateName} (state.type=${issue.stateType || "unknown"}) — ${issue.title}`;
  } catch (error) {
    return `unavailable: ${errorMessage(error)}`;
  }
}

async function writeTicketStatus(config: ResolvedConfig, rawTicket: string): Promise<void> {
  const ticket = rawTicket.toLowerCase();
  const displayTicket = ticket.toUpperCase();
  writeOutput(`groundcrew status ${displayTicket}`);
  writeOutput("=".repeat(`groundcrew status ${displayTicket}`.length));

  // Cached title and url are local; surface them before the
  // network-dependent Linear section so the header is informative even
  // when offline.
  const runState = readRunState(config, ticket);
  writeOutput(
    runState?.url === undefined ? `ticket: ${ticket}` : `ticket: ${ticket}  ${runState.url}`,
  );
  if (runState?.title !== undefined) {
    writeOutput(`title: ${runState.title}`);
  }

  writeConfigSnapshot(config);
  await writeTicketWorktrees(config, ticket);
  const workspaceProbe = await withLogOutputSuppressed(async () => await workspaces.probe(config));
  writeTicketWorkspace(workspaceProbe, ticket);

  writeSection("Run state");
  writeOutput(formatRunState(runState));

  writeSection("Recent logs");
  const logLines = recentTicketLogLines(config, ticket);
  writeOutput(logLines.length === 0 ? "(none)" : logLines.join("\n"));

  writeSection("Last Linear status");
  writeOutput(await linearStatus(ticket));
}

/**
 * Wall-clock elapsed time since the run was first recorded (RunState.createdAt
 * is preserved across resume/interrupt). Returns undefined when the row isn't
 * actively running, when no run state exists, or when the timestamp cannot
 * be parsed.
 */
function runStateDurationMs(runState: RunState | undefined, now: Date): number | undefined {
  if (runState === undefined) {
    return undefined;
  }
  if (runState.state !== "running" && runState.state !== "resumed") {
    return undefined;
  }
  const created = Date.parse(runState.createdAt);
  if (Number.isNaN(created)) {
    return undefined;
  }
  return now.getTime() - created;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function formatDuration(ms: number): string {
  if (ms < MS_PER_MINUTE) {
    return "<1m";
  }
  if (ms < MS_PER_HOUR) {
    return `${Math.floor(ms / MS_PER_MINUTE)}m`;
  }
  if (ms < MS_PER_DAY) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    const minutes = Math.floor((ms - hours * MS_PER_HOUR) / MS_PER_MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms - days * MS_PER_DAY) / MS_PER_HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * Combined human-readable state for the inventory row. Surfaces RunState
 * lifecycle and flags the two interesting disagreements with the workspace
 * probe — `(session dead)` when we recorded a running dispatch but no
 * session is alive, and `(stray session)` when a session is alive without
 * any recorded dispatch. `probe.kind === "unavailable"` is treated as
 * "we don't know" and never produces a suffix. When the row is actively
 * running, appends the elapsed wall-clock time since dispatch.
 */
function inventoryStateText(
  runState: RunState | undefined,
  probe: WorkspaceProbe,
  ticket: string,
  now: Date,
): string {
  const lifecycle = runState?.state ?? "idle";
  const duration = runStateDurationMs(runState, now);
  const flags: string[] = [];
  if (probe.kind === "ok") {
    const sessionLive = probe.names.has(ticket);
    if (lifecycle === "idle" && sessionLive) {
      flags.push("stray session");
    }
    if ((lifecycle === "running" || lifecycle === "resumed") && !sessionLive) {
      flags.push("session dead");
    }
  }
  if (duration !== undefined) {
    flags.push(formatDuration(duration));
  }
  return flags.length === 0 ? lifecycle : `${lifecycle} (${flags.join(", ")})`;
}

/**
 * Hint command for inventory rows where the run-state and the workspace
 * probe disagree. Returned commands are safe defaults; the user is free to
 * ignore them and use `attach:` + `pr:` to investigate first.
 *
 * - Stray session (live session, no run-state record) → `crew cleanup` to
 *   tear down the orphaned worktree + close the session.
 * - Session dead (run-state says running/resumed, no live session) →
 *   `crew resume` to bring the agent back; the worktree is preserved.
 *
 * No hint when the probe is unavailable (we genuinely don't know whether
 * there's a disagreement) or when the row is healthy.
 */
function inventoryHint(
  runState: RunState | undefined,
  probe: WorkspaceProbe,
  ticket: string,
): string | undefined {
  if (probe.kind === "unavailable") {
    return undefined;
  }
  const lifecycle = runState?.state ?? "idle";
  const sessionLive = probe.names.has(ticket);
  if (lifecycle === "idle" && sessionLive) {
    return `run 'crew cleanup ${ticket}' to clear this stray session`;
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && !sessionLive) {
    return `run 'crew resume ${ticket}' to bring the session back`;
  }
  return undefined;
}

const INVENTORY_LABEL_WIDTH = "worktree:".length;

function inventoryField(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(INVENTORY_LABEL_WIDTH)}  ${value}`;
}

function formatPullRequests(prs: readonly PullRequestSummary[]): string {
  return prs.map((pr) => `${pr.url} (${pr.state})`).join(", ");
}

async function writeInventoryWorktrees(
  config: ResolvedConfig,
  probe: WorkspaceProbe,
): Promise<void> {
  writeSection("Worktrees");
  const entries = worktrees
    .list(config)
    .toSorted((left, right) => left.ticket.localeCompare(right.ticket));
  if (entries.length === 0) {
    writeOutput("(none)");
    return;
  }
  const accessHints = await collectAccessHints(config, entries);
  const pullRequests = await collectPullRequests(entries);
  const runStates = new Map<string, RunState | undefined>();
  const now = new Date();
  for (const [index, entry] of entries.entries()) {
    if (!runStates.has(entry.ticket)) {
      runStates.set(entry.ticket, readRunState(config, entry.ticket));
    }
    const runState = runStates.get(entry.ticket);
    const accessHint = accessHints.get(entry.ticket);
    // `collectPullRequests` guarantees an entry for every (repo, branch)
    // pair seen in `entries`; the lookup always returns the array.
    /* v8 ignore next @preserve -- defensive fallback for a Map key that collectPullRequests always populates */
    const prs = pullRequests.get(pullRequestKey(entry.repository, entry.branchName)) ?? [];
    if (index > 0) {
      writeOutput();
    }
    writeOutput(runState?.url === undefined ? entry.ticket : `${entry.ticket}  ${runState.url}`);
    if (runState?.title !== undefined) {
      writeOutput(inventoryField("title", runState.title));
    }
    writeOutput(inventoryField("state", inventoryStateText(runState, probe, entry.ticket, now)));
    writeOutput(inventoryField("repo", entry.repository));
    writeOutput(inventoryField("worktree", entry.dir));
    if (accessHint !== undefined) {
      writeOutput(inventoryField("attach", accessHint.command));
    }
    if (prs.length > 0) {
      writeOutput(inventoryField("pr", formatPullRequests(prs)));
    }
    const hint = inventoryHint(runState, probe, entry.ticket);
    if (hint !== undefined) {
      writeOutput(inventoryField("hint", hint));
    }
  }
}

function pullRequestKey(repository: string, branchName: string): string {
  return `${repository} ${branchName}`;
}

async function collectAccessHints(
  config: ResolvedConfig,
  entries: readonly { ticket: string }[],
): Promise<Map<string, WorkspaceAccessHint | undefined>> {
  const uniqueTickets = [...new Set(entries.map((entry) => entry.ticket))];
  const results = await Promise.all(
    uniqueTickets.map(async (ticket) => {
      const hint = await workspaces.accessHint(config, ticket);
      return [ticket, hint] as const;
    }),
  );
  return new Map(results);
}

async function collectPullRequests(
  entries: readonly { repository: string; branchName: string }[],
): Promise<Map<string, readonly PullRequestSummary[]>> {
  // Same-(repo, branch) entries collapse to one lookup; later inserts
  // overwrite earlier ones with the same identifier, which is fine because
  // gh would return the same PR list for both.
  const uniqueKeys = new Map<string, { repository: string; branchName: string }>();
  for (const entry of entries) {
    uniqueKeys.set(pullRequestKey(entry.repository, entry.branchName), {
      repository: entry.repository,
      branchName: entry.branchName,
    });
  }
  const results = await Promise.all(
    [...uniqueKeys.entries()].map(async ([key, { repository, branchName }]) => {
      const prs = await findPullRequestsForBranch({ repository, branchName });
      return [key, prs] as const;
    }),
  );
  return new Map(results);
}

function writeStraySessions(probe: WorkspaceProbe, worktreeTickets: ReadonlySet<string>): void {
  if (probe.kind === "unavailable") {
    // Surface probe failures so the user knows we couldn't classify strays
    // (silently dropping the section would hide that diagnostic).
    writeSection("Stray sessions");
    writeOutput(workspaceProbeUnavailableLine(probe));
    return;
  }
  const strays = [...probe.names].filter((name) => !worktreeTickets.has(name)).toSorted();
  if (strays.length === 0) {
    return;
  }
  writeSection("Stray sessions");
  writeOutput(strays.join("\n"));
}

function isTodoSourceIssue(issue: SourceIssue): boolean {
  return issue.status === "todo";
}

function hasOpenBlocker(issue: SourceIssue): boolean {
  return issue.blockers.some((b) => b.status !== "done");
}

function describeOpenBlockers(issue: SourceIssue): string {
  return issue.blockers
    .filter((b) => b.status !== "done")
    .map((b) => `${naturalIdFromCanonical(b.id)} (${b.nativeStatus ?? b.status})`)
    .join(", ");
}

function writeQueueIssue(issue: GroundcrewIssue): void {
  const naturalId = naturalIdFromCanonical(issue.id);
  writeOutput(issue.url === undefined ? naturalId : `${naturalId}  ${issue.url}`);
  writeOutput(inventoryField("title", issue.title));
  writeOutput(inventoryField("repo", issue.repository));
  writeOutput(inventoryField("model", issue.model));
}

async function buildBoardForStatus(config: ResolvedConfig): Promise<Board> {
  const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
  return createBoard(sources);
}

type BoardFetchResult =
  | { kind: "ok"; issues: readonly SourceIssue[] }
  | { kind: "error"; error: unknown };

/**
 * Single board fetch used by both the slot count header and the
 * Queue/Blocked sections. `sourcesFromConfig` prepends an implicit Linear
 * source when none are configured, so we always attempt; failures
 * (e.g., missing API key) are captured and rendered later as
 * `unavailable: ...` in the Queue section.
 */
async function fetchBoardForStatus(config: ResolvedConfig): Promise<BoardFetchResult> {
  try {
    const board = await buildBoardForStatus(config);
    const { issues } = await withLogOutputSuppressed(async () => await board.fetch());
    return { kind: "ok", issues };
  } catch (error) {
    return { kind: "error", error };
  }
}

function writeQueueSections(boardResult: BoardFetchResult): void {
  if (boardResult.kind === "error") {
    writeSection("Queue");
    writeOutput(`unavailable: ${errorMessage(boardResult.error)}`);
    return;
  }
  // Only groundcrew-eligible Todos are dispatchable; non-eligible ones lack
  // a repo or model, so `crew run` would skip them.
  const todos = boardResult.issues.filter(isTodoSourceIssue).filter(isGroundcrewIssue);
  const ready = todos.filter((i) => !hasOpenBlocker(i));
  const blocked = todos.filter(hasOpenBlocker);

  // Hide the section entirely when nothing's queued and nothing's blocked.
  if (ready.length > 0) {
    writeSection("Queue");
    for (const [index, issue] of ready.entries()) {
      if (index > 0) {
        writeOutput();
      }
      writeQueueIssue(issue);
    }
  }

  if (blocked.length > 0) {
    writeSection("Blocked");
    for (const [index, issue] of blocked.entries()) {
      if (index > 0) {
        writeOutput();
      }
      writeQueueIssue(issue);
      writeOutput(inventoryField("blocked by", describeOpenBlockers(issue)));
    }
  }
}

function inProgressCount(issues: readonly SourceIssue[]): number {
  return issues.filter((issue) => issue.status === "in-progress").length;
}

async function writeInventoryStatus(config: ResolvedConfig): Promise<void> {
  // Banner ("groundcrew status\n=================") dropped: the command
  // you just ran already tells you what report you're looking at, and the
  // section headers (`Worktrees`, `Queue`, etc.) carry the visual anchors.
  const boardResult = await fetchBoardForStatus(config);
  if (boardResult.kind === "ok") {
    const used = inProgressCount(boardResult.issues);
    writeOutput(`slots: ${used}/${config.orchestrator.maximumInProgress} used`);
  }
  const probe = await withLogOutputSuppressed(async () => await workspaces.probe(config));
  await writeInventoryWorktrees(config, probe);
  const worktreeTickets = new Set(worktrees.list(config).map((entry) => entry.ticket));
  writeStraySessions(probe, worktreeTickets);
  writeQueueSections(boardResult);
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
