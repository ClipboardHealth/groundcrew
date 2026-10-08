import type { RunCommandOptions } from "./commandRunner.ts";
import { fetchPullRequestDetails } from "./pullRequestDetails.ts";

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
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

function graphqlResponse(data: Record<string, unknown>): string {
  return JSON.stringify({ data });
}

function lastGraphqlQueryArgument(mock: typeof runCommandMock): string | undefined {
  const call = mock.mock.calls[0];
  if (call === undefined) {
    return undefined;
  }
  return call[1].at(-1);
}

function fullNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://github.com/acme/widgets/pull/1",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    labels: { nodes: [{ name: "self-reviewed" }, { name: "tested" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

describe(fetchPullRequestDetails, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns an empty map and makes no gh call for zero urls", async () => {
    const result = await fetchPullRequestDetails({ urls: [] });

    expect(result.size).toBe(0);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("sends one aliased variable per url, never interpolating the url into the query", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({}));

    await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1", "https://github.com/acme/widgets/pull/2"],
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "u0=https://github.com/acme/widgets/pull/1",
        "-f",
        "u1=https://github.com/acme/widgets/pull/2",
        "-f",
        expect.stringMatching(/^query=query\(\$u0:URI!,\$u1:URI!\)\{p0: resource/),
      ],
      { timeoutMs: 60_000 },
    );
    expect(lastGraphqlQueryArgument(runCommandMock)).not.toContain(
      "https://github.com/acme/widgets/pull/1",
    );
  });

  it("forwards an explicit signal and timeoutMs", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({}));
    const { signal } = new AbortController();

    await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
      signal,
      timeoutMs: 5000,
    });

    expect(runCommandMock).toHaveBeenCalledWith("gh", expect.any(Array), {
      timeoutMs: 5000,
      signal,
    });
  });

  it("parses a full PR node into a detail", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: fullNode() }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toStrictEqual({
      url: "https://github.com/acme/widgets/pull/1",
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    });
  });

  it.each(["CLOSED", "MERGED"] as const)("parses lifecycle state %s", async (state) => {
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: fullNode({ state }) }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.state).toBe(state);
  });

  it("maps an unrecognized state to an unresolved detail", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: fullNode({ state: "DRAFT" }) }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it.each(["CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const)(
    "parses review decision %s",
    async (reviewDecision) => {
      runCommandMock.mockResolvedValue(graphqlResponse({ p0: fullNode({ reviewDecision }) }));

      const result = await fetchPullRequestDetails({
        urls: ["https://github.com/acme/widgets/pull/1"],
      });

      expect(result.get("https://github.com/acme/widgets/pull/1")?.reviewDecision).toBe(
        reviewDecision,
      );
    },
  );

  it("normalizes a null review decision", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: fullNode({ reviewDecision: null }) }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.reviewDecision).toBeNull();
  });

  it("normalizes an unrecognized review decision to null", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({ p0: fullNode({ reviewDecision: "SOMETHING_NEW" }) }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.reviewDecision).toBeNull();
  });

  it("returns undefined for a missing resource (deleted, inaccessible, or not a PR)", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: null }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it("returns undefined when the node isn't an object", async () => {
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: "not an object" }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it("returns undefined when url is missing", async () => {
    const { url: _url, ...withoutUrl } = fullNode();
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: withoutUrl }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it("returns undefined when isDraft is missing", async () => {
    const { isDraft: _isDraft, ...withoutIsDraft } = fullNode();
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: withoutIsDraft }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it("treats a missing labels field as no labels", async () => {
    const { labels: _labels, ...withoutLabels } = fullNode();
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: withoutLabels }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.labels).toStrictEqual([]);
  });

  it("treats a non-array labels.nodes as no labels", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({ p0: fullNode({ labels: { nodes: "oops" } }) }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.labels).toStrictEqual([]);
  });

  it("skips a non-object label entry and a label with a non-string name", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({
        p0: fullNode({ labels: { nodes: [null, { name: 7 }, { name: "tested" }] } }),
      }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.labels).toStrictEqual(["tested"]);
  });

  it("treats a missing commits field as no checks", async () => {
    const { commits: _commits, ...withoutCommits } = fullNode();
    runCommandMock.mockResolvedValue(graphqlResponse({ p0: withoutCommits }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.checks).toBeNull();
  });

  it("treats a non-array commits.nodes as no checks", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({ p0: fullNode({ commits: { nodes: "oops" } }) }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.checks).toBeNull();
  });

  it("treats a non-object first commit entry as no checks", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({ p0: fullNode({ commits: { nodes: [null] } }) }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.checks).toBeNull();
  });

  it("treats a non-object commit field as no checks", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({ p0: fullNode({ commits: { nodes: [{ commit: "oops" }] } }) }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.checks).toBeNull();
  });

  it("treats a missing statusCheckRollup with no checks run yet as null (passing)", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({
        p0: fullNode({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
      }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.checks).toBeNull();
  });

  it("treats a non-string rollup state as null", async () => {
    runCommandMock.mockResolvedValue(
      graphqlResponse({
        p0: fullNode({
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 7 } } }] },
        }),
      }),
    );

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")?.checks).toBeNull();
  });

  it("throws when gh emits non-JSON output", async () => {
    runCommandMock.mockResolvedValue("not json");

    await expect(
      fetchPullRequestDetails({ urls: ["https://github.com/acme/widgets/pull/1"] }),
    ).rejects.toThrow(/non-JSON output/);
  });

  it("resolves every url to undefined when the top-level response isn't an object", async () => {
    runCommandMock.mockResolvedValue("null");

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it("resolves every url to undefined when the response has no data object", async () => {
    runCommandMock.mockResolvedValue(JSON.stringify({ errors: ["boom"] }));

    const result = await fetchPullRequestDetails({
      urls: ["https://github.com/acme/widgets/pull/1"],
    });

    expect(result.get("https://github.com/acme/widgets/pull/1")).toBeUndefined();
  });

  it("propagates a gh command failure", async () => {
    runCommandMock.mockRejectedValue(new Error("gh: command not found"));

    await expect(
      fetchPullRequestDetails({ urls: ["https://github.com/acme/widgets/pull/1"] }),
    ).rejects.toThrow(/command not found/);
  });
});
