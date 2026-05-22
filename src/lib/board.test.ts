import { createBoard } from "./board.ts";
import type { Issue, TicketSource } from "./ticketSource.ts";

function fakeSource(name: string, overrides: Partial<TicketSource> = {}): TicketSource {
  return {
    name,
    verify: vi.fn<() => Promise<void>>().mockResolvedValue(),
    fetch: vi.fn<() => Promise<Issue[]>>().mockResolvedValue([]),
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires a value for non-void return type
    resolveOne: vi.fn<(id: string) => Promise<Issue | undefined>>().mockResolvedValue(undefined),
    markInProgress: vi.fn<(issue: Issue) => Promise<void>>().mockResolvedValue(),
    ...overrides,
  };
}

function fakeIssue(id: string, source: string): Issue {
  return {
    id,
    source,
    title: id,
    description: "",
    status: "todo",
    repository: "org/repo",
    model: "claude",
    assignee: "x",
    updatedAt: "2026-01-01T00:00:00Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: {},
  };
}

describe(createBoard, () => {
  it("throws when two sources share the same name", () => {
    const a = fakeSource("dup");
    const b = fakeSource("dup");
    expect(() => createBoard([a, b])).toThrow(/duplicate source name "dup"/);
  });
});

describe("Board.verify", () => {
  it("calls verify on every source", async () => {
    const aVerify = vi.fn<() => Promise<void>>().mockResolvedValue();
    const bVerify = vi.fn<() => Promise<void>>().mockResolvedValue();
    const board = createBoard([
      fakeSource("a", { verify: aVerify }),
      fakeSource("b", { verify: bVerify }),
    ]);
    await board.verify();
    expect(aVerify).toHaveBeenCalledTimes(1);
    expect(bVerify).toHaveBeenCalledTimes(1);
  });

  it("aborts startup with the source name when one fails", async () => {
    const failingVerify = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("boom"));
    const board = createBoard([fakeSource("a"), fakeSource("b", { verify: failingVerify })]);
    await expect(board.verify()).rejects.toThrow(/source "b".*boom/);
  });

  it("surfaces a non-Error rejection's stringified reason", async () => {
    const failingVerify = vi.fn<() => Promise<void>>().mockRejectedValue("no good");
    const board = createBoard([fakeSource("a", { verify: failingVerify })]);
    await expect(board.verify()).rejects.toThrow(/source "a".*no good/);
  });

  it("reports every failing source when multiple verify() calls fail simultaneously", async () => {
    // All errors are collected into a single thrown message so users fixing
    // startup misconfig don't have to restart twice to discover the second
    // failure. Each source's name appears in the error.
    const aFail = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("a-failed"));
    const bFail = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("b-failed"));
    const board = createBoard([
      fakeSource("a", { verify: aFail }),
      fakeSource("b", { verify: bFail }),
    ]);
    await expect(board.verify()).rejects.toThrow(/source "a".*a-failed[\s\S]*source "b".*b-failed/);
  });
});

describe("Board.fetch", () => {
  it("merges issues from all sources, preserving each adapter's already-prefixed ids", async () => {
    const aFetch = vi.fn<() => Promise<Issue[]>>().mockResolvedValue([fakeIssue("a:1", "a")]);
    const bFetch = vi
      .fn<() => Promise<Issue[]>>()
      .mockResolvedValue([fakeIssue("b:1", "b"), fakeIssue("b:2", "b")]);
    const board = createBoard([
      fakeSource("a", { fetch: aFetch }),
      fakeSource("b", { fetch: bFetch }),
    ]);
    const state = await board.fetch();
    expect(state.issues.map((i) => i.id).toSorted()).toStrictEqual(["a:1", "b:1", "b:2"]);
  });

  it("stamps an ISO timestamp on the BoardState", async () => {
    const board = createBoard([fakeSource("a")]);
    const before = Date.now();
    const state = await board.fetch();
    const stamp = Date.parse(state.timestamp);
    expect(stamp).toBeGreaterThanOrEqual(before);
  });
});

describe("Board.resolveOne", () => {
  it("routes a canonical id directly to the named source", async () => {
    const aResolve = vi
      .fn<(id: string) => Promise<Issue | undefined>>()
      .mockResolvedValue(fakeIssue("a:1", "a"));
    const bResolve = vi
      .fn<(id: string) => Promise<Issue | undefined>>()
      .mockRejectedValue(new Error("should not be called"));
    const board = createBoard([
      fakeSource("a", { resolveOne: aResolve }),
      fakeSource("b", { resolveOne: bResolve }),
    ]);
    const result = await board.resolveOne("a:1");
    expect(result?.id).toBe("a:1");
    expect(bResolve).not.toHaveBeenCalled();
  });

  it("fans out a natural id and returns the unique match", async () => {
    const bResolve = vi
      .fn<(id: string) => Promise<Issue | undefined>>()
      .mockResolvedValue(fakeIssue("b:x", "b"));
    const board = createBoard([fakeSource("a"), fakeSource("b", { resolveOne: bResolve })]);
    const result = await board.resolveOne("x");
    expect(result?.id).toBe("b:x");
  });

  it("returns undefined when no source matches", async () => {
    const board = createBoard([fakeSource("a"), fakeSource("b")]);
    await expect(board.resolveOne("missing")).resolves.toBeUndefined();
  });

  it("throws AmbiguousTicketError when multiple sources match a natural id", async () => {
    const aResolve = vi
      .fn<(id: string) => Promise<Issue | undefined>>()
      .mockResolvedValue(fakeIssue("a:x", "a"));
    const bResolve = vi
      .fn<(id: string) => Promise<Issue | undefined>>()
      .mockResolvedValue(fakeIssue("b:x", "b"));
    const board = createBoard([
      fakeSource("a", { resolveOne: aResolve }),
      fakeSource("b", { resolveOne: bResolve }),
    ]);
    await expect(board.resolveOne("x")).rejects.toThrow(/ambiguous.*a:x.*b:x/i);
  });

  it("throws when canonical id names an unknown source", async () => {
    const board = createBoard([fakeSource("a")]);
    await expect(board.resolveOne("nope:x")).rejects.toThrow(/unknown source.*nope/);
  });
});

describe("Board.markInProgress", () => {
  it("routes to the adapter named by issue.source", async () => {
    const aMark = vi.fn<(issue: Issue) => Promise<void>>().mockResolvedValue();
    const bMark = vi
      .fn<(issue: Issue) => Promise<void>>()
      .mockRejectedValue(new Error("wrong source"));
    const board = createBoard([
      fakeSource("a", { markInProgress: aMark }),
      fakeSource("b", { markInProgress: bMark }),
    ]);
    await board.markInProgress(fakeIssue("a:1", "a"));
    expect(aMark).toHaveBeenCalledTimes(1);
    expect(bMark).not.toHaveBeenCalled();
  });

  it("throws when issue.source names an unknown source", async () => {
    const board = createBoard([fakeSource("a")]);
    await expect(board.markInProgress(fakeIssue("nope:1", "nope"))).rejects.toThrow(
      /unknown source.*nope/,
    );
  });
});
