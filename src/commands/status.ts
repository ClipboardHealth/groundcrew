import { readFileSync } from "node:fs";

import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import {
  type CanonicalStatus,
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

function formatDirtiness(dirtiness: WorktreeDirtiness): string {
  if (dirtiness.kind === "dirty") {
    return `dirty (${dirtiness.modified} modified, ${dirtiness.untracked} untracked)`;
  }
  return dirtiness.kind;
}

async function writeTicketWorktrees(config: ResolvedConfig, ticket: string): Promise<void> {
  writeSection("Worktrees");
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
      cwd: entry.dir,
      branchName: entry.branchName,
    });
    writeOutput(`- ${entry.repository} ${entry.kind}`);
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

function ticketWorkspaceText(probe: WorkspaceProbe, ticket: string): string {
  if (probe.kind === "unavailable") {
    return workspaceProbeUnavailableLine(probe);
  }
  if (isWorkspaceExited(probe, ticket)) {
    return "exited";
  }
  return probe.names.has(ticket) ? "live" : "not live";
}

function isWorkspaceExited(probe: WorkspaceProbe, ticket: string): boolean {
  return probe.kind === "ok" && probe.exitedNames?.has(ticket) === true;
}

function formatRunState(state: RunState | undefined, flags: readonly string[] = []): string {
  if (state === undefined) {
    return "(none)";
  }
  // Only the leading lifecycle token gains the reconciliation flags; the
  // `;`-separated detail (model/updated/resumes/reason) is preserved verbatim.
  const lifecycle = flags.length === 0 ? state.state : `${state.state} (${flags.join(", ")})`;
  const summary = `${lifecycle}; model=${state.model}; updated=${state.updatedAt}; resumes=${state.resumeCount}`;
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

async function resolveTicketSource(
  config: ResolvedConfig,
  ticket: string,
): Promise<SourceIssue | undefined> {
  const board = await buildBoardForStatus(config);
  return await withLogOutputSuppressed(async () => await board.resolveOne(ticket));
}

type TicketSourceStatus =
  | { kind: "found"; issue: SourceIssue }
  | { kind: "not-found" }
  | { kind: "unavailable"; reason: string };

async function readTicketSourceStatus(
  config: ResolvedConfig,
  ticket: string,
): Promise<TicketSourceStatus> {
  try {
    const issue = await resolveTicketSource(config, ticket);
    if (issue === undefined) {
      return { kind: "not-found" };
    }
    return { kind: "found", issue };
  } catch (error) {
    return { kind: "unavailable", reason: errorMessage(error) };
  }
}

function writeRecentLogs(config: ResolvedConfig, ticket: string): void {
  const logLines = recentTicketLogLines(config, ticket);
  if (logLines.length === 0) {
    return;
  }
  writeSection("Recent logs");
  writeOutput(logLines.join("\n"));
}

async function exitedWorkspaceAccessHint(
  config: ResolvedConfig,
  probe: WorkspaceProbe,
  ticket: string,
): Promise<WorkspaceAccessHint | undefined> {
  if (!isWorkspaceExited(probe, ticket)) {
    return undefined;
  }
  try {
    return await withLogOutputSuppressed(async () => await workspaces.accessHint(config, ticket));
  } catch {
    return undefined;
  }
}

function formatTicketLine(
  ticket: string,
  runState: RunState | undefined,
  sourceStatus: TicketSourceStatus,
): string {
  const parts = [`ticket: ${ticket}`];
  if (sourceStatus.kind === "found") {
    parts.push(sourceStatus.issue.status);
  }
  const url =
    sourceStatus.kind === "found" ? (sourceStatus.issue.url ?? runState?.url) : runState?.url;
  if (url !== undefined) {
    parts.push(url);
  }
  if (sourceStatus.kind === "not-found") {
    parts.push("source not found");
  }
  if (sourceStatus.kind === "unavailable") {
    parts.push(`source unavailable: ${sourceStatus.reason}`);
  }
  return parts.join("  ");
}

function writeTicketTitle(runState: RunState | undefined, sourceStatus: TicketSourceStatus): void {
  const cachedTitle = runState?.title;
  const sourceTitle = sourceStatus.kind === "found" ? sourceStatus.issue.title : undefined;
  const title = cachedTitle ?? sourceTitle;
  if (title !== undefined) {
    writeOutput(`title: ${title}`);
  }
  if (cachedTitle !== undefined && sourceTitle !== undefined && cachedTitle !== sourceTitle) {
    writeOutput(`source title: ${sourceTitle}`);
  }
}

async function writeTicketStatus(config: ResolvedConfig, rawTicket: string): Promise<void> {
  const ticket = rawTicket.toLowerCase();
  const displayTicket = ticket.toUpperCase();
  writeOutput(`groundcrew status ${displayTicket}`);
  writeOutput("=".repeat(`groundcrew status ${displayTicket}`.length));

  const runState = readRunState(config, ticket);
  const [workspaceProbe, sourceStatus] = await Promise.all([
    withLogOutputSuppressed(async () => await workspaces.probe(config)),
    readTicketSourceStatus(config, ticket),
  ]);
  const accessHint = await exitedWorkspaceAccessHint(config, workspaceProbe, ticket);
  writeOutput(formatTicketLine(ticket, runState, sourceStatus));
  writeTicketTitle(runState, sourceStatus);
  writeOutput(`run: ${formatRunState(runState, runProbeFlags(runState, workspaceProbe, ticket))}`);
  writeOutput(`workspace: ${ticketWorkspaceText(workspaceProbe, ticket)}`);
  if (accessHint !== undefined) {
    writeOutput(`attach: ${accessHint.command}`);
  }

  await writeTicketWorktrees(config, ticket);
  writeRecentLogs(config, ticket);
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
 * Probe-reconciliation flags shared by the inventory row and the per-ticket
 * `run:` line. Flags the two interesting disagreements between the recorded
 * RunState lifecycle and the live workspace probe: a running/resumed dispatch
 * with a missing or exited session, and an idle row with a stray live or
 * exited session. `probe.kind === "unavailable"` is "we don't know" and yields
 * no flags. Excludes the duration token, which only the inventory row appends.
 */
function runProbeFlags(
  runState: RunState | undefined,
  probe: WorkspaceProbe,
  ticket: string,
): string[] {
  if (probe.kind !== "ok") {
    return [];
  }
  const lifecycle = runState?.state ?? "idle";
  const sessionPresent = probe.names.has(ticket);
  const sessionExited = isWorkspaceExited(probe, ticket);
  const flags: string[] = [];
  if (lifecycle === "idle" && sessionPresent) {
    flags.push(sessionExited ? "stray exited session" : "stray session");
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && sessionExited) {
    flags.push("session exited");
  } else if ((lifecycle === "running" || lifecycle === "resumed") && !sessionPresent) {
    flags.push("session dead");
  }
  return flags;
}

/**
 * Combined human-readable state for the inventory row. Surfaces RunState
 * lifecycle and flags the two interesting disagreements with the workspace
 * probe via `runProbeFlags`. When the row is actively running, appends the
 * elapsed wall-clock time since dispatch.
 */
function inventoryStateText(
  runState: RunState | undefined,
  probe: WorkspaceProbe,
  ticket: string,
  now: Date,
): string {
  const lifecycle = runState?.state ?? "idle";
  const flags = runProbeFlags(runState, probe, ticket);
  const duration = runStateDurationMs(runState, now);
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
 * - Stray session (session present, no run-state record) -> `crew cleanup`
 *   to tear down the orphaned worktree and close the session.
 * - Session exited (run-state says running/resumed, kept dead tmux window)
 *   -> attach first so the failed command remains available for inspection.
 * - Session dead (run-state says running/resumed, no session present) ->
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
  const sessionPresent = probe.names.has(ticket);
  const sessionExited = isWorkspaceExited(probe, ticket);
  if (lifecycle === "idle" && sessionPresent) {
    return sessionExited
      ? `run 'crew cleanup ${ticket}' to clear this stray exited session`
      : `run 'crew cleanup ${ticket}' to clear this stray session`;
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && sessionExited) {
    return `attach to inspect scrollback, then run 'crew resume ${ticket}'`;
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && !sessionPresent) {
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

/**
 * Inventory `ticket:` value: the worktree's remote canonical status. Slots are
 * consumed solely by `in-progress` issues (see `inProgressCount`), so that one
 * status is spelled out as `slot held` to make the otherwise-implicit rule
 * legible on the row; every other status renders bare.
 */
function formatTicketStatus(canonicalStatus: CanonicalStatus): string {
  return canonicalStatus === "in-progress" ? "in-progress (slot held)" : canonicalStatus;
}

async function writeInventoryWorktrees(
  config: ResolvedConfig,
  probe: WorkspaceProbe,
  statusByTicket: ReadonlyMap<string, CanonicalStatus> | undefined,
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
    // `collectPullRequests` guarantees an entry for every worktree dir seen
    // in `entries`; the lookup always returns the array.
    /* v8 ignore next @preserve -- defensive fallback for a Map key that collectPullRequests always populates */
    const prs = pullRequests.get(entry.dir) ?? [];
    if (index > 0) {
      writeOutput();
    }
    writeOutput(runState?.url === undefined ? entry.ticket : `${entry.ticket}  ${runState.url}`);
    if (runState?.title !== undefined) {
      writeOutput(inventoryField("title", runState.title));
    }
    writeOutput(inventoryField("state", inventoryStateText(runState, probe, entry.ticket, now)));
    // `state:` is the local run lifecycle; `ticket:` is the remote status that
    // actually drives the slot count. They're sourced independently and can
    // legitimately disagree, so they sit adjacent. Omitted when the board fetch
    // failed (no map) or the ticket isn't in the fetched board.
    const ticketStatus = statusByTicket?.get(entry.ticket);
    if (ticketStatus !== undefined) {
      writeOutput(inventoryField("ticket", formatTicketStatus(ticketStatus)));
    }
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

async function collectAccessHints(
  config: ResolvedConfig,
  entries: readonly { ticket: string }[],
): Promise<Map<string, WorkspaceAccessHint | undefined>> {
  const uniqueTickets = [...new Set(entries.map((entry) => entry.ticket))];
  const results = await Promise.allSettled(
    uniqueTickets.map(async (ticket) => await workspaces.accessHint(config, ticket)),
  );
  return new Map(
    uniqueTickets.map((ticket, index) => {
      const result = results[index];
      return [ticket, result?.status === "fulfilled" ? result.value : undefined] as const;
    }),
  );
}

async function collectPullRequests(
  entries: readonly { dir: string; branchName: string }[],
): Promise<Map<string, readonly PullRequestSummary[]>> {
  // Each worktree dir is unique, so keying by dir collapses nothing in
  // practice; the Map removes duplicates defensively if the same dir
  // appears twice.
  const uniqueByDir = new Map<string, { dir: string; branchName: string }>();
  for (const entry of entries) {
    uniqueByDir.set(entry.dir, { dir: entry.dir, branchName: entry.branchName });
  }
  const results = await Promise.allSettled(
    [...uniqueByDir.entries()].map(async ([dir, { branchName }]) => {
      const prs = await findPullRequestsForBranch({ cwd: dir, branchName });
      return [dir, prs] as const;
    }),
  );
  return new Map(
    [...uniqueByDir.keys()].map((dir, index) => {
      const result = results[index];
      return [dir, result?.status === "fulfilled" ? result.value[1] : []] as const;
    }),
  );
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

/**
 * Maps each fetched issue's lowercased natural id to its canonical status when
 * exactly one fetched issue has that natural id, so the Worktrees section can
 * show a `ticket:` field per row without guessing across sources. The key
 * matches the lowercased `WorktreeEntry.ticket` (same join as
 * `inProgressWithoutWorktree`). `undefined` when the board fetch failed —
 * callers then omit the field rather than guess.
 */
function statusByWorktreeTicket(
  boardResult: BoardFetchResult,
): ReadonlyMap<string, CanonicalStatus> | undefined {
  if (boardResult.kind !== "ok") {
    return undefined;
  }
  const statuses = new Map<string, CanonicalStatus>();
  const matchCounts = new Map<string, number>();
  for (const issue of boardResult.issues) {
    const ticket = naturalIdFromCanonical(issue.id).toLowerCase();
    matchCounts.set(ticket, (matchCounts.get(ticket) ?? 0) + 1);
    statuses.set(ticket, issue.status);
  }
  for (const [ticket, matchCount] of matchCounts) {
    if (matchCount > 1) {
      statuses.delete(ticket);
    }
  }
  return statuses;
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

/**
 * In-progress board issues that have no local worktree. These count toward the
 * `slots: N/M used` total but are absent from the Worktrees section (their
 * worktree was removed, or lives outside this config's projectDir /
 * knownRepositories), so without this they'd be counted yet invisible. Worktree
 * tickets are lowercased, so the natural id is lowercased before matching.
 */
function inProgressWithoutWorktree(
  issues: readonly SourceIssue[],
  worktreeTickets: ReadonlySet<string>,
): SourceIssue[] {
  return issues
    .filter((issue) => issue.status === "in-progress")
    .filter((issue) => !worktreeTickets.has(naturalIdFromCanonical(issue.id).toLowerCase()))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function writeInProgressIssue(issue: SourceIssue): void {
  const naturalId = naturalIdFromCanonical(issue.id);
  writeOutput(issue.url === undefined ? naturalId : `${naturalId}  ${issue.url}`);
  writeOutput(inventoryField("title", issue.title));
  // These are all in-progress by definition, but spell out the slot-held
  // status so every holder row reads the same whether or not it has a worktree.
  writeOutput(inventoryField("ticket", formatTicketStatus(issue.status)));
  if (issue.repository !== undefined) {
    writeOutput(inventoryField("repo", issue.repository));
  }
}

function writeInProgressWithoutWorktree(
  boardResult: BoardFetchResult,
  worktreeTickets: ReadonlySet<string>,
): void {
  if (boardResult.kind !== "ok") {
    return;
  }
  const issues = inProgressWithoutWorktree(boardResult.issues, worktreeTickets);
  if (issues.length === 0) {
    return;
  }
  writeSection("In progress (no local worktree)");
  for (const [index, issue] of issues.entries()) {
    if (index > 0) {
      writeOutput();
    }
    writeInProgressIssue(issue);
  }
}

async function writeInventoryStatus(config: ResolvedConfig): Promise<void> {
  // Banner ("groundcrew status\n=================") dropped: the command
  // you just ran already tells you what report you're looking at, and the
  // section headers (`Worktrees`, `Queue`, etc.) carry the visual anchors.
  // The board fetch runs concurrently with the probe, but we await it before
  // rendering: each Worktrees row carries the remote ticket status, so the
  // inventory can't print until the source resolves. A failed fetch returns
  // quickly and still renders rows (without the `ticket:` field).
  const boardResultPromise = fetchBoardForStatus(config);
  const probe = await withLogOutputSuppressed(async () => await workspaces.probe(config));
  const boardResult = await boardResultPromise;
  await writeInventoryWorktrees(config, probe, statusByWorktreeTicket(boardResult));
  const worktreeTickets = new Set(worktrees.list(config).map((entry) => entry.ticket));
  writeStraySessions(probe, worktreeTickets);

  writeInProgressWithoutWorktree(boardResult, worktreeTickets);
  if (boardResult.kind === "ok") {
    const used = inProgressCount(boardResult.issues);
    writeOutput();
    writeOutput(`slots: ${used}/${config.orchestrator.maximumInProgress} used`);
  }
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
