import type { RunCommandOptions } from "./commandRunner.ts";
import { findPullRequestsForBranch } from "./pullRequests.ts";

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

describe(findPullRequestsForBranch, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("parses gh's JSON output into typed PR summaries", async () => {
    runCommandMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/acme/widgets/pull/42",
          number: 42,
          state: "OPEN",
          title: "Wire up auth",
        },
      ]),
    );

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
    runCommandMock.mockResolvedValueOnce("[]");

    await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "feature/auth",
    });

    expect(runCommandMock).toHaveBeenCalledTimes(1);
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
    runCommandMock.mockResolvedValueOnce(
      JSON.stringify([
        { url: "https://x/pull/1", number: 1, state: "MERGED", title: "a" },
        { url: "https://x/pull/2", number: 2, state: "CLOSED", title: "b" },
      ]),
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs.map((p) => p.state)).toStrictEqual(["merged", "closed"]);
  });

  it("returns empty when gh fails (not installed / not authenticated / network)", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("gh: command not found"));

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("returns empty when gh emits non-JSON output", async () => {
    runCommandMock.mockResolvedValueOnce("not json at all");

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("returns empty when gh emits a non-array JSON value", async () => {
    runCommandMock.mockResolvedValueOnce("null");

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs).toStrictEqual([]);
  });

  it("skips entries that don't match the expected PR shape", async () => {
    runCommandMock.mockResolvedValueOnce(
      JSON.stringify([
        { url: "https://x/pull/1", number: 1, state: "OPEN", title: "valid" },
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
    runCommandMock.mockResolvedValueOnce("[]");
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
    runCommandMock.mockResolvedValueOnce(
      JSON.stringify([{ url: "https://x/pull/1", number: 1, state: "DRAFT", title: "wip" }]),
    );

    const prs = await findPullRequestsForBranch({
      cwd: "/work/widgets-team-1",
      branchName: "x",
    });

    expect(prs[0]?.state).toBe("draft");
  });
});
