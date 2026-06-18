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

interface RawPullRequestFixture {
  url: string;
  number: number;
  state: string;
  title: string;
}

function rawPullRequest(overrides: Partial<RawPullRequestFixture> = {}): RawPullRequestFixture {
  return {
    url: overrides.url ?? "https://github.com/acme/widgets/pull/42",
    number: overrides.number ?? 42,
    state: overrides.state ?? "OPEN",
    title: overrides.title ?? "Wire up auth",
  };
}

describe(findPullRequestsForBranch, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("parses gh's JSON output into typed PR summaries", async () => {
    runCommandMock.mockResolvedValue(JSON.stringify([rawPullRequest()]));

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
      },
    ]);
  });

  it("runs gh in the worktree dir and omits --repo so gh resolves the remote", async () => {
    runCommandMock.mockResolvedValue("[]");

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
  });

  it("normalises MERGED and CLOSED states to lowercase", async () => {
    runCommandMock.mockResolvedValue(
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

  it("returns merged, open, and closed PRs verbatim so the caller can decide how to use them", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify([
        rawPullRequest({ number: 1, state: "MERGED" }),
        rawPullRequest({ number: 2, state: "OPEN" }),
        rawPullRequest({ number: 3, state: "CLOSED" }),
      ]),
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.number)).toStrictEqual([1, 2, 3]);
  });

  it("returns empty when gh fails (not installed / not authenticated / network)", async () => {
    runCommandMock.mockRejectedValue(new Error("gh: command not found"));

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("returns empty when gh emits non-JSON output", async () => {
    runCommandMock.mockResolvedValue("not json at all");

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("returns empty when gh emits a non-array JSON value", async () => {
    runCommandMock.mockResolvedValue("null");

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("skips entries that don't match the expected PR shape", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify([
        rawPullRequest({ url: "https://x/pull/1", number: 1, state: "OPEN", title: "valid" }),
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
    runCommandMock.mockResolvedValue("[]");
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
  });

  it("forwards a lowercased unknown state value verbatim", async () => {
    runCommandMock.mockResolvedValue(
      JSON.stringify([rawPullRequest({ state: "DRAFT", title: "wip" })]),
    );

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
