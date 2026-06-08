import { setVerbose } from "../lib/util.ts";
import { canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import type { Board } from "../lib/board.ts";
import type { PullRequestSummary } from "../lib/pullRequests.ts";
import type { BoardState, Issue, MarkDoneResult, MarkInReviewResult } from "../lib/taskSource.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import { makeBoard } from "../testHelpers/boardFixtures.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { createReviewer, type FindPullRequests } from "./reviewer.ts";

function boardOf(issues: BoardState["issues"]): BoardState {
  return { timestamp: "2025-01-01T00:00:00.000Z", issues, parentSkips: [] };
}

function inProgressIssue(naturalId: string, overrides: Partial<Issue> = {}): Issue {
  return canonicalLinearIssue({
    naturalId,
    status: "in-progress",
    repository: "repo-a",
    ...overrides,
  });
}

function hostEntryFor(task: string, overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repository: "repo-a",
    task,
    branchName: `dev-${task}`,
    dir: `/work/repo-a-${task}`,
    kind: "host",
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    url: overrides.url ?? "https://github.com/x/y/pull/1",
    number: overrides.number ?? 1,
    state: overrides.state ?? "open",
    title: overrides.title ?? "PR title",
    headRefOid: overrides.headRefOid ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

function findReturning(prs: readonly PullRequestSummary[]): FindPullRequests {
  return vi.fn<FindPullRequests>().mockResolvedValue(prs);
}

describe(createReviewer, () => {
  let consoleLog: ConsoleCapture;
  let markInReviewMock: ReturnType<typeof vi.fn<(issue: Issue) => Promise<MarkInReviewResult>>>;
  let markDoneMock: ReturnType<typeof vi.fn<(issue: Issue) => Promise<MarkDoneResult>>>;
  let board: Board;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    markInReviewMock = vi
      .fn<(issue: Issue) => Promise<MarkInReviewResult>>()
      .mockResolvedValue({ outcome: "applied" });
    markDoneMock = vi
      .fn<(issue: Issue) => Promise<MarkDoneResult>>()
      .mockResolvedValue({ outcome: "applied" });
    board = makeBoard({ markInReview: markInReviewMock, markDone: markDoneMock });
    // review telemetry (event= lines) is diagnostic — verbose echoes it to the
    // console so these cases can assert the wording.
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
    vi.clearAllMocks();
  });

  it("does nothing when there are no in-progress or in-review candidates", async () => {
    const findPullRequests = findReturning([pullRequest()]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([
        canonicalLinearIssue({ naturalId: "team-1", status: "todo" }),
        canonicalLinearIssue({ naturalId: "team-2", status: "done" }),
      ]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(findPullRequests).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it("advances an in-progress task whose worktree has an open PR", async () => {
    const issue = inProgressIssue("team-1");
    const findPullRequests = findReturning([
      pullRequest({ state: "open", url: "https://gh/pr/7" }),
    ]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([issue]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(findPullRequests).toHaveBeenCalledWith({
      cwd: "/work/repo-a-team-1",
      branchName: "dev-team-1",
    });
    expect(markInReviewMock).toHaveBeenCalledWith(issue);
    const out = consoleLog.output();
    expect(out).toContain("Advanced team-1 to in-review (PR https://gh/pr/7)");
    expect(out).toContain("event=review outcome=advanced task=team-1");
  });

  it("advances a merged PR to done (not in-review)", async () => {
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "merged", url: "https://gh/pr/3" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(markDoneMock).toHaveBeenCalledTimes(1);
    expect(markInReviewMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("Advanced team-1 to done (PR https://gh/pr/3)");
    expect(out).toContain("event=review outcome=advanced task=team-1");
    expect(out).toContain("to=done");
  });

  it("advances an in-review task to done when its PR has merged", async () => {
    const issue = inProgressIssue("team-1", { status: "in-review" });
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "merged" })]),
    });

    await reviewer.runOnce({
      state: boardOf([issue]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(markDoneMock).toHaveBeenCalledWith(issue);
    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("leaves an in-review task alone when it only has an open PR", async () => {
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "open" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1", { status: "in-review" })]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(markDoneMock).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("does not fall back to in-review when a merged PR's source cannot mark done", async () => {
    markDoneMock.mockResolvedValueOnce({
      outcome: "unsupported",
      reason: "source has no done transition",
    });
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "merged" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(markDoneMock).toHaveBeenCalledTimes(1);
    expect(markInReviewMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("Skipped advancing team-1 to done: source has no done transition");
    expect(out).not.toContain("Advanced team-1 to");
  });

  it("dry-run logs a would-advance to done for a merged PR and writes nothing", async () => {
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "merged", url: "https://gh/pr/5" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: true,
    });

    expect(markDoneMock).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("[dry-run] Would advance team-1 to done (PR https://gh/pr/5)");
    expect(out).toContain("event=review outcome=skipped reason=dry_run task=team-1");
  });

  it("skips when the worktree has no PR (or the lookup failed)", async () => {
    const reviewer = createReviewer({ board, findPullRequests: findReturning([]) });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("skips when the only PR is closed without merging", async () => {
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "closed" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("skips (does not throw) when the PR lookup itself rejects", async () => {
    // findPullRequestsForBranch is contracted never to reject, but a misbehaving
    // injected lookup must not abort the tick — the issue is skipped, retried next tick.
    const findPullRequests = vi.fn<FindPullRequests>().mockRejectedValue(new Error("gh blew up"));
    const reviewer = createReviewer({ board, findPullRequests });

    await expect(
      reviewer.runOnce({
        state: boardOf([inProgressIssue("team-1")]),
        worktreeEntries: [hostEntryFor("team-1")],
        dryRun: false,
      }),
    ).resolves.toBeUndefined();

    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("keeps advancing other issues when one issue's write-back fails", async () => {
    // Error isolation: a write-back failure on the first issue must not prevent
    // the second qualifying issue from being advanced in the same tick.
    markInReviewMock
      .mockRejectedValueOnce(new Error("team-1 shell error"))
      .mockResolvedValueOnce({ outcome: "applied" });
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "open" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(markInReviewMock).toHaveBeenCalledTimes(2);
    const out = consoleLog.output();
    expect(out).toContain("Failed to advance team-1 to in-review");
    expect(out).toContain("Advanced team-2 to in-review");
  });

  it("keeps advancing other merged tasks when one issue's markDone fails", async () => {
    // Error isolation on the done path: a markDone failure on the first merged
    // task must not prevent the second merged task from advancing this tick.
    markDoneMock
      .mockRejectedValueOnce(new Error("team-1 shell error"))
      .mockResolvedValueOnce({ outcome: "applied" });
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "merged" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(markDoneMock).toHaveBeenCalledTimes(2);
    expect(markInReviewMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("Failed to advance team-1 to done");
    expect(out).toContain("Advanced team-2 to done");
  });

  it("never looks up PRs for a todo task even if it has a worktree", async () => {
    const findPullRequests = findReturning([pullRequest({ state: "open" })]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "todo" })]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(findPullRequests).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("skips an in-progress task that has no matching worktree", async () => {
    const findPullRequests = findReturning([pullRequest({ state: "open" })]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("other-9")],
      dryRun: false,
    });

    expect(findPullRequests).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("skips an in-progress task that has no repository", async () => {
    const findPullRequests = findReturning([pullRequest({ state: "open" })]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1", { repository: undefined })]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    expect(findPullRequests).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("matches worktrees by task and repository", async () => {
    const findPullRequests = findReturning([pullRequest({ state: "open" })]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1", { repository: "repo-a" })]),
      worktreeEntries: [hostEntryFor("team-1", { repository: "repo-b" })],
      dryRun: false,
    });

    expect(findPullRequests).not.toHaveBeenCalled();
    expect(markInReviewMock).not.toHaveBeenCalled();
  });

  it("dry-run logs the would-advance and does not write back", async () => {
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "open", url: "https://gh/pr/9" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: true,
    });

    expect(markInReviewMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("[dry-run] Would advance team-1 to in-review (PR https://gh/pr/9)");
    expect(out).toContain("event=review outcome=skipped reason=dry_run task=team-1");
  });

  it("logs and swallows a writeback failure, leaving the task for next tick", async () => {
    markInReviewMock.mockRejectedValue(new Error("shell exploded"));
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "open" })]),
    });

    await expect(
      reviewer.runOnce({
        state: boardOf([inProgressIssue("team-1")]),
        worktreeEntries: [hostEntryFor("team-1")],
        dryRun: false,
      }),
    ).resolves.toBeUndefined();

    const out = consoleLog.output();
    expect(out).toContain("Failed to advance team-1 to in-review: shell exploded");
    expect(out).toContain("event=review outcome=failed reason=writeback_failed task=team-1");
  });

  it("does not log success when the source does not support in-review writeback", async () => {
    markInReviewMock.mockResolvedValueOnce({
      outcome: "unsupported",
      reason: "source has no in-review transition",
    });
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "open", url: "https://gh/pr/1" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
    });

    const out = consoleLog.output();
    expect(out).toContain(
      "Skipped advancing team-1 to in-review: source has no in-review transition",
    );
    expect(out).toContain("event=review outcome=skipped reason=unsupported task=team-1");
    expect(out).not.toContain("Advanced team-1 to in-review");
  });

  it("falls through to a later worktree when the first has no PR", async () => {
    // First worktree lookup yields no PR; the second has an open one. The
    // reviewer must keep scanning the issue's worktrees rather than give up.
    const findPullRequests = vi
      .fn<FindPullRequests>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pullRequest({ state: "open" })]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [
        hostEntryFor("team-1", { dir: "/work/repo-a-team-1-first", branchName: "dev-team-1-a" }),
        hostEntryFor("team-1", { dir: "/work/repo-a-team-1-second", branchName: "dev-team-1-b" }),
      ],
      dryRun: false,
    });

    expect(findPullRequests).toHaveBeenCalledTimes(2);
    expect(markInReviewMock).toHaveBeenCalledTimes(1);
  });

  it("makes at most one transition per issue even with multiple reviewable worktrees", async () => {
    const findPullRequests = findReturning([pullRequest({ state: "open" })]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [
        hostEntryFor("team-1", { dir: "/work/repo-a-team-1-first", branchName: "dev-team-1-a" }),
        hostEntryFor("team-1", { dir: "/work/repo-a-team-1-second", branchName: "dev-team-1-b" }),
      ],
      dryRun: false,
    });

    // Stops at the first reviewable worktree: one lookup, one write-back.
    expect(findPullRequests).toHaveBeenCalledTimes(1);
    expect(markInReviewMock).toHaveBeenCalledTimes(1);
  });

  it("advances every in-progress task that qualifies", async () => {
    const reviewer = createReviewer({
      board,
      findPullRequests: findReturning([pullRequest({ state: "open" })]),
    });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(markInReviewMock).toHaveBeenCalledTimes(2);
  });

  it("threads the abort signal into the PR lookup", async () => {
    const { signal } = new AbortController();
    const findPullRequests = findReturning([]);
    const reviewer = createReviewer({ board, findPullRequests });

    await reviewer.runOnce({
      state: boardOf([inProgressIssue("team-1")]),
      worktreeEntries: [hostEntryFor("team-1")],
      dryRun: false,
      signal,
    });

    expect(findPullRequests).toHaveBeenCalledWith({
      cwd: "/work/repo-a-team-1",
      branchName: "dev-team-1",
      signal,
    });
  });
});
