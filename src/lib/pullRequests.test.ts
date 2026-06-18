import type { RunCommandOptions } from "./commandRunner.ts";
import { findPullRequestsForBranch, resolvePullRequest } from "./pullRequests.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- single recorder for the captured-stdio overload of runCommandAsync
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

const WORKTREE_HEAD_OID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STALE_HEAD_OID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR_AHEAD_OF_LOCAL_OID = "cccccccccccccccccccccccccccccccccccccccc";
const LOCAL_AHEAD_OF_PR_OID = "dddddddddddddddddddddddddddddddddddddddd";
const MISSING_PR_HEAD_OID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

type AncestorVerdict = "ancestor" | "not-ancestor" | "missing";

interface RawPullRequestFixture {
  url: string;
  number: number;
  state: string;
  title: string;
  headRefOid: string;
}

function rawPullRequest(overrides: Partial<RawPullRequestFixture> = {}): RawPullRequestFixture {
  return {
    url: overrides.url ?? "https://github.com/acme/widgets/pull/42",
    number: overrides.number ?? 42,
    state: overrides.state ?? "OPEN",
    title: overrides.title ?? "Wire up auth",
    headRefOid: overrides.headRefOid ?? WORKTREE_HEAD_OID,
  };
}

function commandFailure(status: number): Error {
  const cause = Object.assign(new Error("Command exited unsuccessfully"), { status });
  return new Error(`Command failed (test fixture)\nExit status: ${status}`, { cause });
}

function mockSuccessfulLookup(
  output: string,
  currentHeadOid: string = WORKTREE_HEAD_OID,
  ancestorMap: Readonly<Record<string, AncestorVerdict>> = {},
): void {
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command === "gh") {
      return output;
    }
    if (command !== "git") {
      throw new Error(`unexpected command: ${command}`);
    }
    const [verb, flag, ancestor, descendant] = arguments_;
    if (verb === "rev-parse" && flag === "HEAD") {
      return currentHeadOid;
    }
    if (verb === "merge-base" && flag === "--is-ancestor") {
      const verdict = ancestorMap[`${ancestor}->${descendant}`];
      if (verdict === undefined) {
        throw new Error(`unmocked merge-base --is-ancestor ${ancestor} ${descendant}`);
      }
      if (verdict === "ancestor") {
        return "";
      }
      throw commandFailure(verdict === "not-ancestor" ? 1 : 128);
    }
    throw new Error(`unexpected git args: ${arguments_.join(" ")}`);
  });
}

function mockMergeBaseRawError(prNumber: number, prHeadOid: string, mergeBaseError: Error): void {
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command === "gh") {
      return JSON.stringify([rawPullRequest({ number: prNumber, headRefOid: prHeadOid })]);
    }
    if (command !== "git") {
      throw new Error(`unexpected command: ${command}`);
    }
    if (arguments_[0] === "rev-parse") {
      return WORKTREE_HEAD_OID;
    }
    if (arguments_[0] === "merge-base") {
      throw mergeBaseError;
    }
    throw new Error(`unexpected git args: ${arguments_.join(" ")}`);
  });
}

function mockFailedGhLookup(): void {
  runCommandMock.mockImplementation(async (command) => {
    if (command === "git") {
      return WORKTREE_HEAD_OID;
    }
    throw new Error("gh: command not found");
  });
}

describe(findPullRequestsForBranch, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("parses gh's JSON output into typed PR summaries", async () => {
    mockSuccessfulLookup(JSON.stringify([rawPullRequest()]));

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "feature/auth",
    });

    expect(prs).toStrictEqual([
      {
        url: "https://github.com/acme/widgets/pull/42",
        number: 42,
        state: "open",
        title: "Wire up auth",
        headRefOid: WORKTREE_HEAD_OID,
      },
    ]);
  });

  it("runs gh in the worktree dir and omits --repo so gh resolves the remote", async () => {
    mockSuccessfulLookup("[]");

    await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "feature/auth",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "list", "--head", "feature/auth"]),
      { cwd: "/work/widgets-team-1" },
    );
    expect(runCommandMock).toHaveBeenCalledWith("gh", expect.not.arrayContaining(["--repo"]), {
      cwd: "/work/widgets-team-1",
    });
    expect(runCommandMock).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      cwd: "/work/widgets-team-1",
    });
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["merge-base"]),
      expect.anything(),
    );
  });

  it("normalises MERGED and CLOSED states to lowercase", async () => {
    mockSuccessfulLookup(
      JSON.stringify([
        rawPullRequest({ url: "https://x/pull/1", number: 1, state: "MERGED", title: "a" }),
        rawPullRequest({ url: "https://x/pull/2", number: 2, state: "CLOSED", title: "b" }),
      ]),
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.state)).toStrictEqual(["merged", "closed"]);
  });

  it("drops PRs whose head is on a history unrelated to local HEAD (branch-name reuse)", async () => {
    mockSuccessfulLookup(
      JSON.stringify([
        rawPullRequest({ number: 1, state: "MERGED", headRefOid: STALE_HEAD_OID }),
        rawPullRequest({ number: 2, state: "OPEN" }),
      ]),
      WORKTREE_HEAD_OID,
      {
        [`${STALE_HEAD_OID}->${WORKTREE_HEAD_OID}`]: "not-ancestor",
        [`${WORKTREE_HEAD_OID}->${STALE_HEAD_OID}`]: "not-ancestor",
      },
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([2]);
  });

  it("keeps a PR whose head is an ancestor of local HEAD (local has WIP commits on top)", async () => {
    mockSuccessfulLookup(
      JSON.stringify([rawPullRequest({ number: 7, headRefOid: PR_AHEAD_OF_LOCAL_OID })]),
      WORKTREE_HEAD_OID,
      { [`${PR_AHEAD_OF_LOCAL_OID}->${WORKTREE_HEAD_OID}`]: "ancestor" },
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([7]);
  });

  it("keeps a PR whose head is ahead of local HEAD (PR has a merge-master commit)", async () => {
    mockSuccessfulLookup(
      JSON.stringify([rawPullRequest({ number: 8, headRefOid: LOCAL_AHEAD_OF_PR_OID })]),
      WORKTREE_HEAD_OID,
      {
        [`${LOCAL_AHEAD_OF_PR_OID}->${WORKTREE_HEAD_OID}`]: "not-ancestor",
        [`${WORKTREE_HEAD_OID}->${LOCAL_AHEAD_OF_PR_OID}`]: "ancestor",
      },
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([8]);
  });

  it("keeps a PR whose head is not in the local object DB (favor visibility over a missed fetch)", async () => {
    mockSuccessfulLookup(
      JSON.stringify([rawPullRequest({ number: 9, headRefOid: MISSING_PR_HEAD_OID })]),
      WORKTREE_HEAD_OID,
      {
        [`${MISSING_PR_HEAD_OID}->${WORKTREE_HEAD_OID}`]: "missing",
        [`${WORKTREE_HEAD_OID}->${MISSING_PR_HEAD_OID}`]: "missing",
      },
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([9]);
  });

  it("keeps a PR when merge-base fails with an error that has no cause (e.g. spawn ENOENT)", async () => {
    mockMergeBaseRawError(12, STALE_HEAD_OID, new Error("spawn ENOENT"));

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([12]);
  });

  it("keeps a PR when merge-base fails with a wrapper cause that carries no status field", async () => {
    mockMergeBaseRawError(
      13,
      STALE_HEAD_OID,
      new Error("wrapped", { cause: new Error("nested without status") }),
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([13]);
  });

  it("preserves gh's ordering across a mixed batch of equal / ancestor / unrelated / descendant heads", async () => {
    mockSuccessfulLookup(
      JSON.stringify([
        rawPullRequest({ number: 100 }),
        rawPullRequest({ number: 101, headRefOid: PR_AHEAD_OF_LOCAL_OID }),
        rawPullRequest({ number: 102, headRefOid: STALE_HEAD_OID }),
        rawPullRequest({ number: 103, headRefOid: LOCAL_AHEAD_OF_PR_OID }),
      ]),
      WORKTREE_HEAD_OID,
      {
        [`${PR_AHEAD_OF_LOCAL_OID}->${WORKTREE_HEAD_OID}`]: "ancestor",
        [`${STALE_HEAD_OID}->${WORKTREE_HEAD_OID}`]: "not-ancestor",
        [`${WORKTREE_HEAD_OID}->${STALE_HEAD_OID}`]: "not-ancestor",
        [`${LOCAL_AHEAD_OF_PR_OID}->${WORKTREE_HEAD_OID}`]: "not-ancestor",
        [`${WORKTREE_HEAD_OID}->${LOCAL_AHEAD_OF_PR_OID}`]: "ancestor",
      },
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([100, 101, 103]);
  });

  it("keeps a PR when forward is not-ancestor but reverse is unknown (reverse-arm fallback)", async () => {
    mockSuccessfulLookup(
      JSON.stringify([rawPullRequest({ number: 15, headRefOid: MISSING_PR_HEAD_OID })]),
      WORKTREE_HEAD_OID,
      {
        [`${MISSING_PR_HEAD_OID}->${WORKTREE_HEAD_OID}`]: "not-ancestor",
        [`${WORKTREE_HEAD_OID}->${MISSING_PR_HEAD_OID}`]: "missing",
      },
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([15]);
  });

  it("forwards the AbortSignal to merge-base invocations alongside cwd", async () => {
    mockSuccessfulLookup(
      JSON.stringify([rawPullRequest({ number: 14, headRefOid: PR_AHEAD_OF_LOCAL_OID })]),
      WORKTREE_HEAD_OID,
      { [`${PR_AHEAD_OF_LOCAL_OID}->${WORKTREE_HEAD_OID}`]: "ancestor" },
    );
    const { signal } = new AbortController();

    await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
      signal,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["merge-base", "--is-ancestor", PR_AHEAD_OF_LOCAL_OID, WORKTREE_HEAD_OID],
      { cwd: "/work/widgets-team-1", signal },
    );
  });

  it("skips merge-base entirely on OID equality (fast path)", async () => {
    mockSuccessfulLookup(JSON.stringify([rawPullRequest({ number: 11 })]));

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([11]);
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["merge-base"]),
      expect.anything(),
    );
  });

  it("returns empty when gh fails (not installed / not authenticated / network)", async () => {
    mockFailedGhLookup();

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("returns empty when gh emits non-JSON output", async () => {
    mockSuccessfulLookup("not json at all");

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("returns empty when gh emits a non-array JSON value", async () => {
    mockSuccessfulLookup("null");

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("skips entries that don't match the expected PR shape", async () => {
    mockSuccessfulLookup(
      JSON.stringify([
        rawPullRequest({ url: "https://x/pull/1", number: 1, state: "OPEN", title: "valid" }),
        { url: "https://x/pull/9", number: 9, state: "OPEN", title: "missing head oid" },
        { url: 42, number: "not a number" }, // malformed; dropped silently
        null, // also dropped
      ]),
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([1]);
  });

  it("forwards the AbortSignal to runCommandAsync alongside cwd when provided", async () => {
    mockSuccessfulLookup("[]");
    const { signal } = new AbortController();

    await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
      signal,
    });

    expect(runCommandMock).toHaveBeenCalledWith("gh", expect.any(Array), {
      cwd: "/work/widgets-team-1",
      signal,
    });
    expect(runCommandMock).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      cwd: "/work/widgets-team-1",
      signal,
    });
  });

  it("forwards a lowercased unknown state value verbatim", async () => {
    mockSuccessfulLookup(JSON.stringify([rawPullRequest({ state: "DRAFT", title: "wip" })]));

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs[0]?.state).toBe("draft");
  });
});

function rawResolved(): string {
  return JSON.stringify({
    number: 42,
    headRefName: "jdoe/fix-thing",
    title: "Wire up auth",
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    isCrossRepository: false,
  });
}

describe(resolvePullRequest, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("resolves a PR to its head branch, title, url, and fork flag", async () => {
    runCommandMock.mockResolvedValue(rawResolved());

    const actual = await resolvePullRequest({
      repoDir: "/work/acme/widgets",
      pr: "42",
    });

    expect(actual).toStrictEqual({
      number: 42,
      branch: "jdoe/fix-thing",
      title: "Wire up auth",
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      isCrossRepository: false,
    });
  });

  it("runs gh pr view in the clone dir and lets gh resolve the repo remote", async () => {
    runCommandMock.mockResolvedValue(rawResolved());

    await resolvePullRequest({ repoDir: "/work/acme/widgets", pr: "42" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "42", "--json", "number,headRefName,title,url,state,isCrossRepository"],
      { cwd: "/work/acme/widgets" },
    );
    expect(runCommandMock).toHaveBeenCalledWith("gh", expect.not.arrayContaining(["--repo"]), {
      cwd: "/work/acme/widgets",
    });
  });

  it("forwards the AbortSignal alongside cwd when provided", async () => {
    runCommandMock.mockResolvedValue(rawResolved());
    const { signal } = new AbortController();

    await resolvePullRequest({
      repoDir: "/work/acme/widgets",
      pr: "42",
      signal,
    });

    expect(runCommandMock).toHaveBeenCalledWith("gh", expect.any(Array), {
      cwd: "/work/acme/widgets",
      signal,
    });
  });

  it("normalises the lifecycle state to lowercase", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify({
        number: 7,
        headRefName: "feature/x",
        title: "x",
        url: "https://x/pull/7",
        state: "MERGED",
        isCrossRepository: false,
      }),
    );

    const actual = await resolvePullRequest({
      repoDir: "/work/acme/widgets",
      pr: "7",
    });

    expect(actual.state).toBe("merged");
  });

  it("flags a cross-repository (fork) PR", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify({
        number: 9,
        headRefName: "contributor:patch",
        title: "fork pr",
        url: "https://x/pull/9",
        state: "OPEN",
        isCrossRepository: true,
      }),
    );

    const actual = await resolvePullRequest({
      repoDir: "/work/acme/widgets",
      pr: "9",
    });

    expect(actual.isCrossRepository).toBe(true);
  });

  it("throws a clear error when gh fails", async () => {
    runCommandMock.mockRejectedValue(new Error("gh: command not found"));

    await expect(resolvePullRequest({ repoDir: "/work/acme/widgets", pr: "42" })).rejects.toThrow(
      /Could not look up pull request 42 from \/work\/acme\/widgets/,
    );
  });

  it("throws when gh emits non-JSON output", async () => {
    runCommandMock.mockResolvedValue("not json");

    await expect(resolvePullRequest({ repoDir: "/work/acme/widgets", pr: "42" })).rejects.toThrow(
      /non-JSON response/,
    );
  });

  it("throws when gh emits an unexpected JSON shape", async () => {
    runCommandMock.mockResolvedValue(JSON.stringify({ number: 42 }));

    await expect(resolvePullRequest({ repoDir: "/work/acme/widgets", pr: "42" })).rejects.toThrow(
      /Unexpected response shape/,
    );
  });

  it("throws when gh emits a non-object JSON value", async () => {
    runCommandMock.mockResolvedValue("null");

    await expect(resolvePullRequest({ repoDir: "/work/acme/widgets", pr: "42" })).rejects.toThrow(
      /Unexpected response shape/,
    );
  });

  it("forwards a lowercased unknown state verbatim", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify({
        number: 3,
        headRefName: "wip/x",
        title: "wip",
        url: "https://x/pull/3",
        state: "DRAFT",
        isCrossRepository: false,
      }),
    );

    const actual = await resolvePullRequest({
      repoDir: "/work/acme/widgets",
      pr: "3",
    });

    expect(actual.state).toBe("draft");
  });
});
