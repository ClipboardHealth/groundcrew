import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import type { PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, recordRunState } from "../lib/runState.ts";
import type { BoardState, Issue } from "../lib/taskSource.ts";
import { canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import { setVerbose } from "../lib/util.ts";
import { reclaimStackParentBranch, type WorktreeEntry } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import type { FindPullRequests } from "./reviewer.ts";
import {
  createStackRetarget,
  type RunGhCommand,
  type RunGitCommand,
  type StackRetarget,
} from "./stackRetarget.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

const reclaimStackParentBranchMock = vi.hoisted(() => vi.fn<typeof reclaimStackParentBranch>());

vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    reclaimStackParentBranch: reclaimStackParentBranchMock,
  };
});

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
    url: overrides.url ?? "https://github.com/x/y/pull/7",
    number: overrides.number ?? 7,
    state: overrides.state ?? "open",
    title: overrides.title ?? "PR title",
    ...(overrides.baseRefName === undefined ? {} : { baseRefName: overrides.baseRefName }),
  };
}

type PullRequestRoute = Error | readonly PullRequestSummary[];

/** Routes findPullRequests by branchName: the child's own branch vs. its parent's. A route may be an Error to simulate a failed lookup. */
function findPullRequestsRoutedBy(routes: Record<string, PullRequestRoute>): FindPullRequests {
  return vi.fn<FindPullRequests>(async ({ branchName }) => {
    const route = routes[branchName];
    if (route instanceof Error) {
      throw route;
    }
    return route ?? [];
  });
}

type GitCall = { args: readonly string[]; signal?: AbortSignal };

interface GitFakeHandlers {
  status?: () => Promise<string>;
  fetch?: () => Promise<string>;
  rebase?: () => Promise<string>;
  rebaseAbort?: () => Promise<string>;
  push?: () => Promise<string>;
}

function gitFakeHandlerFor(
  handlers: GitFakeHandlers,
  args: readonly string[],
): (() => Promise<string>) | undefined {
  const [command] = args;
  if (command === "rebase" && args.includes("--abort")) {
    return handlers.rebaseAbort;
  }
  const byCommand: Record<string, (() => Promise<string>) | undefined> = {
    "--no-optional-locks": handlers.status,
    fetch: handlers.fetch,
    rebase: handlers.rebase,
    push: handlers.push,
  };
  return command === undefined ? undefined : byCommand[command];
}

function gitFake(handlers: GitFakeHandlers): RunGitCommand & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  const fn = vi.fn<RunGitCommand>(async ({ args, signal }) => {
    calls.push({ args, ...(signal === undefined ? {} : { signal }) });
    return await (gitFakeHandlerFor(handlers, args)?.() ?? Promise.resolve(""));
  });
  return Object.assign(fn, { calls });
}

type GitRoute = Error | string;

/** Routes a git call by its exact argv, joined with spaces — for scenarios where two calls share a command (e.g. two `fetch`s with different refs) and need different outcomes. */
function routedGitFake(routes: Record<string, GitRoute>): RunGitCommand & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  const fn = vi.fn<RunGitCommand>(async ({ args, signal }) => {
    calls.push({ args, ...(signal === undefined ? {} : { signal }) });
    const route = routes[args.join(" ")];
    if (route instanceof Error) {
      throw route;
    }
    return route ?? "";
  });
  return Object.assign(fn, { calls });
}

function makeConfig(stateRoot: string): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: path.join(stateRoot, "groundcrew.log") },
  };
}

describe(createStackRetarget, () => {
  let consoleLog: ConsoleCapture;
  let stateRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    stateRoot = mkdtempSync(path.join(tmpdir(), "groundcrew-stack-retarget-"));
    config = makeConfig(stateRoot);
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
    rmSync(stateRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function recordChildRunState(overrides: { baseBranch: string; parentTask: string }): void {
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-2",
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
        baseBranch: overrides.baseBranch,
        parentTask: overrides.parentTask,
      },
    });
  }

  it("does nothing for a task with no baseBranch in run state", async () => {
    const findPullRequests = findPullRequestsRoutedBy({});
    const stackRetarget: StackRetarget = createStackRetarget({ findPullRequests });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(findPullRequests).not.toHaveBeenCalled();
  });

  it("retargets the PR onto the parent branch while the parent is still open", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, baseRefName: "main" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["pr", "edit", "7", "--base", "dev-team-1"] }),
    );
    const out = consoleLog.output();
    expect(out).toContain("corrected the PR base to the parent branch");
    expect(out).toContain(
      "event=stack-retarget flow=stack-retarget task=team-2 parentTask=team-1 baseBranch=dev-team-1 outcome=retargeted_to_parent",
    );
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("does nothing once the PR is already based on the parent and the parent is still open", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, baseRefName: "main" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).not.toHaveBeenCalled();
    expect(consoleLog.output()).not.toContain("stack-retarget");
  });

  it("retargets to the default branch and rebases when the parent merged and the worktree is clean", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const runGit = gitFake({ status: async () => "" });
    const stackRetarget = createStackRetarget({ findPullRequests, runGh, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["pr", "edit", "7", "--base", "main"] }),
    );
    expect(runGit.calls.map((call) => call.args[0])).toEqual([
      "--no-optional-locks",
      "fetch",
      "rebase",
      "push",
    ]);
    expect(runGit.calls[1]?.args).toEqual(["fetch", "origin", "main", "dev-team-1"]);
    expect(runGit.calls[2]?.args).toEqual(["rebase", "--onto", "origin/main", "origin/dev-team-1"]);
    expect(runGit.calls[3]?.args).toEqual(["push", "--force-with-lease"]);

    const state = readRunState(config, "team-2");
    expect(state?.baseBranch).toBeUndefined();
    expect(state?.parentTask).toBe("team-1");
    expect(state?.needsRebase).toBeUndefined();
    expect(consoleLog.output()).toContain(
      "event=stack-retarget flow=stack-retarget task=team-2 parentTask=team-1 baseBranch=dev-team-1 outcome=rebased_onto_default",
    );
    // The parent's worktree is usually gone by the time a child rebases —
    // nothing else will revisit its preserved branch, so this rebase does.
    expect(reclaimStackParentBranchMock).toHaveBeenCalledWith(config, {
      repository: "repo-a",
      parentTask: "team-1",
      branchName: "dev-team-1",
    });
  });

  it("logs and keeps the rebased_onto_default outcome when the parent branch reclaim fails", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    reclaimStackParentBranchMock.mockRejectedValueOnce(
      new Error("branch is checked out in another worktree"),
    );
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const runGit = gitFake({ status: async () => "" });
    const stackRetarget = createStackRetarget({ findPullRequests, runGh, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(readRunState(config, "team-2")?.baseBranch).toBeUndefined();
    expect(consoleLog.output()).toContain(
      "Stack parent branch reclaim failed for team-1: branch is checked out in another worktree",
    );
    expect(consoleLog.output()).toContain("outcome=rebased_onto_default");
  });

  it("shells out through the real git and gh runners when neither is injected", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    runCommandMock.mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "edit", "7", "--base", "main"],
      expect.objectContaining({ cwd: "/work/repo-a-team-2" }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "main", "dev-team-1"],
      expect.objectContaining({ cwd: "/work/repo-a-team-2" }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["push", "--force-with-lease"],
      expect.objectContaining({ cwd: "/work/repo-a-team-2" }),
    );
  });

  it("forwards the abort signal through the real git and gh runners when neither is injected", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    runCommandMock.mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests });
    const controller = new AbortController();

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
      signal: controller.signal,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "edit", "7", "--base", "main"],
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["push", "--force-with-lease"],
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("detects the parent as merged via its issue's canonical status, without a parent PR lookup", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
    });
    const runGit = gitFake({ status: async () => "" });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(findPullRequests).toHaveBeenCalledTimes(1);
    expect(readRunState(config, "team-2")?.baseBranch).toBeUndefined();
  });

  it("leaves the PR alone when the parent merged but the base is neither the parent nor the default branch", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "some-other-branch" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const runGit = gitFake({});
    const stackRetarget = createStackRetarget({ findPullRequests, runGh, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).not.toHaveBeenCalled();
    expect(runGit.calls).toHaveLength(0);
    expect(consoleLog.output()).not.toContain("stack-retarget");
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("retargets but flags needsRebase, without rebasing, when the worktree is dirty", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const runGit = gitFake({ status: async () => " M src/index.ts\n" });
    const stackRetarget = createStackRetarget({ findPullRequests, runGh, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["pr", "edit", "7", "--base", "main"] }),
    );
    expect(runGit.calls.map((call) => call.args[0])).toEqual(["--no-optional-locks"]);
    const state = readRunState(config, "team-2");
    expect(state?.needsRebase).toBe(true);
    expect(state?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=retargeted_needs_rebase");
  });

  it("aborts and flags needsRebase on a rebase conflict", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = gitFake({
      status: async () => "",
      rebase: async () => {
        throw new Error("CONFLICT (content): Merge conflict in src/index.ts");
      },
    });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGit.calls.map((call) => call.args)).toContainEqual(["rebase", "--abort"]);
    const state = readRunState(config, "team-2");
    expect(state?.needsRebase).toBe(true);
    expect(state?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=rebase_conflict");
  });

  it("flags needsRebase when the force-push is rejected after a clean rebase", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = gitFake({
      status: async () => "",
      push: async () => {
        throw new Error("stale info; the remote branch moved");
      },
    });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    const state = readRunState(config, "team-2");
    expect(state?.needsRebase).toBe(true);
    expect(state?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=push_rejected");
  });

  it("skips straight to the rebase path when GitHub already retargeted the PR itself", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const runGit = gitFake({ status: async () => "" });
    const stackRetarget = createStackRetarget({ findPullRequests, runGh, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).not.toHaveBeenCalled();
    expect(readRunState(config, "team-2")?.baseBranch).toBeUndefined();
    expect(consoleLog.output()).toContain("outcome=rebased_onto_default");
  });

  it("logs a WARN-worthy failure and retries next tick when gh pr edit fails, without throwing", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, baseRefName: "main" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockRejectedValue(new Error("gh: not authenticated"));
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await expect(
      stackRetarget.runOnce({
        config,
        state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
        worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
        dryRun: false,
      }),
    ).resolves.toBeUndefined();

    expect(consoleLog.output()).toContain("outcome=retarget_failed");
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("keeps processing other tasks when one task's PR lookup rejects", async () => {
    recordRunState({
      config,
      state: {
        task: "team-3",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-3",
        branchName: "dev-team-3",
        workspaceName: "team-3",
        state: "running",
        baseBranch: "dev-team-1",
        parentTask: "team-1",
      },
    });
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-3": new Error("gh blew up"),
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, baseRefName: "main" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await expect(
      stackRetarget.runOnce({
        config,
        state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
        worktreeEntries: [hostEntryFor("team-3"), hostEntryFor("team-1"), hostEntryFor("team-2")],
        dryRun: false,
      }),
    ).resolves.toBeUndefined();

    expect(runGh).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["pr", "edit", "7", "--base", "dev-team-1"] }),
    );
  });

  it("processes each task's worktree entry at most once per tick", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, baseRefName: "main" })],
    });
    const stackRetarget = createStackRetarget({ findPullRequests });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2"), hostEntryFor("team-2")],
      dryRun: false,
    });

    // One lookup for the child's own branch, one for the parent's — not
    // doubled by the duplicate worktree entry for the same task.
    expect(findPullRequests).toHaveBeenCalledTimes(2);
  });

  it("dry-run performs no gh/git mutation and logs would-retarget", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, baseRefName: "main" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-1"), inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-1"), hostEntryFor("team-2")],
      dryRun: true,
    });

    expect(runGh).not.toHaveBeenCalled();
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=skipped reason=dry_run");
  });

  it("does nothing when the child has no open pull request", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ state: "closed", baseRefName: "main" })],
    });
    const stackRetarget = createStackRetarget({ findPullRequests });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(findPullRequests).toHaveBeenCalledTimes(1);
    expect(consoleLog.output()).not.toContain("stack-retarget");
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("treats a failed parent-PR lookup as parent-not-merged and retargets to the parent", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": new Error("gh rate limited"),
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGh).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["pr", "edit", "7", "--base", "dev-team-1"] }),
    );
    expect(consoleLog.output()).toContain("outcome=retargeted_to_parent");
  });

  it("logs retarget_failed when gh pr edit fails while retargeting a merged parent's PR onto the default branch", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockRejectedValue(new Error("gh: not authenticated"));
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(consoleLog.output()).toContain("outcome=retarget_failed");
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("dry-run logs the rebase-only plan when GitHub already retargeted the merged parent's PR", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = vi.fn<RunGitCommand>();
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: true,
    });

    expect(runGit).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("would rebase the branch onto the default branch");
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("dry-run logs the retarget-and-rebase plan when the merged parent's PR still needs retargeting", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>();
    const stackRetarget = createStackRetarget({ findPullRequests, runGh });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: true,
    });

    expect(runGh).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain(
      "would retarget the pull request onto the default branch and rebase",
    );
    expect(readRunState(config, "team-2")?.baseBranch).toBe("dev-team-1");
  });

  it("treats a failed dirty-check probe as dirty and flags needsRebase", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = gitFake({
      status: async () => {
        throw new Error("fatal: not a git repository");
      },
    });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    const state = readRunState(config, "team-2");
    expect(state?.needsRebase).toBe(true);
    expect(state?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=retargeted_needs_rebase");
  });

  it("falls back to fetching only the default branch when the combined fetch fails, then rebases onto the local parent ref", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = routedGitFake({
      "--no-optional-locks status --porcelain": "",
      "fetch origin main dev-team-1": new Error("could not read from remote: dev-team-1 not found"),
      "fetch origin main": "",
      "rebase --onto origin/main dev-team-1": "",
      "push --force-with-lease": "",
    });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    expect(runGit.calls.map((call) => call.args.join(" "))).toContain("fetch origin main");
    expect(readRunState(config, "team-2")?.baseBranch).toBeUndefined();
    expect(consoleLog.output()).toContain("outcome=rebased_onto_default");
  });

  it("flags needsRebase when both the combined fetch and its default-branch-only fallback fail", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = routedGitFake({
      "--no-optional-locks status --porcelain": "",
      "fetch origin main dev-team-1": new Error("network unreachable"),
      "fetch origin main": new Error("network unreachable"),
    });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
    });

    const state = readRunState(config, "team-2");
    expect(state?.needsRebase).toBe(true);
    expect(state?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=retargeted_needs_rebase");
  });

  it("swallows a failed rebase --abort and still flags needsRebase", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "main" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGit = gitFake({
      status: async () => "",
      rebase: async () => {
        throw new Error("CONFLICT (content): Merge conflict in src/index.ts");
      },
      rebaseAbort: async () => {
        throw new Error("no rebase in progress");
      },
    });
    const stackRetarget = createStackRetarget({ findPullRequests, runGit });

    await expect(
      stackRetarget.runOnce({
        config,
        state: boardOf([inProgressIssue("team-2")]),
        worktreeEntries: [hostEntryFor("team-2")],
        dryRun: false,
      }),
    ).resolves.toBeUndefined();

    const state = readRunState(config, "team-2");
    expect(state?.needsRebase).toBe(true);
    expect(state?.baseBranch).toBe("dev-team-1");
    expect(consoleLog.output()).toContain("outcome=rebase_conflict");
  });

  it("forwards the abort signal to every gh and git call along the retarget-and-rebase path", async () => {
    recordChildRunState({ baseBranch: "dev-team-1", parentTask: "team-1" });
    const findPullRequests = findPullRequestsRoutedBy({
      "dev-team-2": [pullRequest({ baseRefName: "dev-team-1" })],
      "dev-team-1": [pullRequest({ number: 3, state: "merged" })],
    });
    const runGh = vi.fn<RunGhCommand>().mockResolvedValue("");
    const runGit = gitFake({ status: async () => "" });
    const stackRetarget = createStackRetarget({ findPullRequests, runGh, runGit });
    const controller = new AbortController();

    await stackRetarget.runOnce({
      config,
      state: boardOf([inProgressIssue("team-2")]),
      worktreeEntries: [hostEntryFor("team-2")],
      dryRun: false,
      signal: controller.signal,
    });

    expect(findPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(runGh).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(runGit.calls.length).toBeGreaterThan(0);
    expect(runGit.calls.every((call) => call.signal === controller.signal)).toBe(true);
  });
});
