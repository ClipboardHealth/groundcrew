/**
 * Per-iteration scanner that posts a followup comment to Linear when a
 * ticket reaches a terminal status, before `Cleaner` tears down the
 * worktree. One per `orchestrate()` invocation; stateless across
 * iterations. Mirrors `Dispatcher` and `Cleaner`.
 */

import type { LinearClient } from "@linear/sdk";

import { type BoardState, isTerminalStatus, type Issue } from "../lib/boardSource.ts";
import { runCommandAsync } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { createLinearCommentsClient, type LinearCommentsClient } from "../lib/linearComments.ts";
import { errorMessage, log, logEvent } from "../lib/util.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";

interface ReporterDeps {
  config: ResolvedConfig;
  client: LinearClient;
}

export interface Reporter {
  runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
}

export function createReporter(deps: ReporterDeps): Reporter {
  const { config, client } = deps;
  const comments = createLinearCommentsClient({ client });

  async function runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { state, worktreeEntries, dryRun, signal } = arguments_;
    const terminalIssues = state.issues.filter((issue) => isTerminalStatus(issue.status, config));
    if (terminalIssues.length === 0) {
      return;
    }

    for (const issue of terminalIssues) {
      const entry = pickEntry(worktreeEntries, issue.id);
      if (entry === undefined) {
        // No worktree means Cleaner has already removed it on a previous
        // tick — there's nothing left to summarize, and a followup posted
        // now would be missing the git/gh data anyway.
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- followups are independent but Linear rate limits favor sequential posts
        await processIssue({
          issue,
          entry,
          comments,
          config,
          dryRun,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        const message = errorMessage(error);
        log(`Followup for ${issue.id} failed: ${message}`);
        logEvent("reporter", {
          outcome: "failed",
          reason: "post_failed",
          ticket: issue.id,
          error: message,
        });
      }
    }
  }

  return { runOnce };
}

async function processIssue(arguments_: {
  issue: Issue;
  entry: WorktreeEntry;
  comments: LinearCommentsClient;
  config: ResolvedConfig;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { issue, entry, comments, config, dryRun, signal } = arguments_;

  if (dryRun) {
    log(`[dry-run] Would post followup for ${issue.id}`);
    logEvent("reporter", {
      outcome: "skipped",
      reason: "dry_run",
      ticket: issue.id,
    });
    return;
  }

  if (await comments.hasFollowup(issue.uuid)) {
    logEvent("reporter", {
      outcome: "skipped",
      reason: "already_posted",
      ticket: issue.id,
    });
    return;
  }

  const summary = await gatherSummary({
    entry,
    config,
    ...(signal === undefined ? {} : { signal }),
  });
  const body = buildBody({ issue, summary });
  await comments.postFollowup({ issueUuid: issue.uuid, body });
  log(`Posted followup for ${issue.id}`);
  logEvent("reporter", { outcome: "posted", ticket: issue.id });
}

interface Summary {
  branch: string;
  commitCount: number;
  prUrl: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

async function gatherSummary(arguments_: {
  entry: WorktreeEntry;
  config: ResolvedConfig;
  signal?: AbortSignal;
}): Promise<Summary> {
  const { entry, config, signal } = arguments_;
  const baseBranch = config.git.defaultBranch;
  const runOptions = {
    cwd: entry.dir,
    ...(signal === undefined ? {} : { signal }),
  };

  const commitsOutput = await runCommandAsync(
    "git",
    ["log", "--oneline", `${baseBranch}..HEAD`],
    runOptions,
  );
  const commitCount = countCommits(commitsOutput);

  const diffOutput = await runCommandAsync(
    "git",
    ["diff", "--shortstat", `${baseBranch}...HEAD`],
    runOptions,
  );
  const { filesChanged, insertions, deletions } = parseShortStat(diffOutput);

  const prUrl = await lookupPrUrl(runOptions);

  return {
    branch: entry.branchName,
    commitCount,
    prUrl,
    filesChanged,
    insertions,
    deletions,
  };
}

async function lookupPrUrl(runOptions: { cwd: string; signal?: AbortSignal }): Promise<string> {
  try {
    return await runCommandAsync("gh", ["pr", "view", "--json", "url", "--jq", ".url"], runOptions);
  } catch {
    // `gh pr view` exits non-zero when no PR exists for the branch — that's
    // a normal state for a ticket that was completed without opening a PR,
    // so we surface it in the comment body rather than failing the post.
    return "no PR found";
  }
}

function countCommits(output: string): number {
  if (output.length === 0) {
    return 0;
  }
  return output.split("\n").filter((line) => line.length > 0).length;
}

interface ShortStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

function parseShortStat(line: string): ShortStat {
  const filesMatch = /(\d+) files? changed/.exec(line);
  const insertMatch = /(\d+) insertions?\(\+\)/.exec(line);
  const deleteMatch = /(\d+) deletions?\(-\)/.exec(line);
  return {
    filesChanged: parseCount(filesMatch?.[1]),
    insertions: parseCount(insertMatch?.[1]),
    deletions: parseCount(deleteMatch?.[1]),
  };
}

function parseCount(value: string | undefined): number {
  // value is `undefined` (the regex group didn't match) or a `\d+` capture —
  // `Number.parseInt` on a digit string always returns a finite integer, so
  // no NaN/Infinity guard is needed.
  return value === undefined ? 0 : Number.parseInt(value, 10);
}

function buildBody(arguments_: { issue: Issue; summary: Summary }): string {
  const { issue, summary } = arguments_;
  return [
    `groundcrew finished ${issue.id.toUpperCase()}.`,
    "",
    `Branch: ${summary.branch} (${summary.commitCount} commits)`,
    `PR: ${summary.prUrl}`,
    `Files changed: ${summary.filesChanged} (+${summary.insertions} / -${summary.deletions})`,
  ].join("\n");
}

function pickEntry(entries: readonly WorktreeEntry[], ticket: string): WorktreeEntry | undefined {
  return entries.find((entry) => entry.ticket === ticket);
}
