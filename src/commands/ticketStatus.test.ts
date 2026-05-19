import {
  decideVerdict,
  type DecideVerdictInput,
  type LinearStatusProbe,
  type LocalBranchProbe,
  type PullRequestProbe,
  type RemoteBranchProbe,
  type StatusVerdict,
  type WorktreeProbe,
} from "./ticketStatus.ts";

// Type-only smoke test — keeps `knip` happy while later tasks wire these types
// into the orchestrator and probes.
type _ProbeUnion =
  | LinearStatusProbe
  | LocalBranchProbe
  | PullRequestProbe
  | RemoteBranchProbe
  | StatusVerdict
  | WorktreeProbe;
const _typeSmokeTest: readonly _ProbeUnion[] = [];
void _typeSmokeTest;

function makeInput(overrides: Partial<DecideVerdictInput> = {}): DecideVerdictInput {
  return {
    linear: { kind: "terminal", stateName: "Done" },
    worktree: { kind: "absent" },
    localBranch: { kind: "absent" },
    remoteBranch: { kind: "absent" },
    pullRequest: { kind: "absent" },
    branch: "paul-hrd-1",
    worktreeDir: undefined,
    workspaceName: undefined,
    ...overrides,
  };
}

function assertRecoverable(
  verdict: StatusVerdict,
): asserts verdict is Extract<StatusVerdict, { kind: "recoverable" }> {
  expect(verdict.kind).toBe("recoverable");
}

function assertInFlight(
  verdict: StatusVerdict,
): asserts verdict is Extract<StatusVerdict, { kind: "in-flight" }> {
  expect(verdict.kind).toBe("in-flight");
}

describe("decideVerdict pure verdict logic", () => {
  it("row 1 — terminal + nothing local + no PR → lost", () => {
    const actual = decideVerdict(makeInput());

    expect(actual.kind).toBe("lost");
  });

  it("row 2 — terminal + remote branch only + no PR → recoverable (gh pr create)", () => {
    const actual = decideVerdict(makeInput({ remoteBranch: { kind: "present" } }));

    assertRecoverable(actual);
    expect(actual.nextStep).toMatch(/gh pr create --head paul-hrd-1/);
  });

  it("row 3 — terminal + remote branch + open PR → pr-open", () => {
    const actual = decideVerdict(
      makeInput({
        remoteBranch: { kind: "present" },
        pullRequest: { kind: "open", number: 42, url: "https://github.com/x/y/pull/42" },
      }),
    );

    expect(actual).toMatchObject({ kind: "pr-open", number: 42 });
  });

  it("row 4 — terminal + remote branch + merged PR → pr-merged", () => {
    const actual = decideVerdict(
      makeInput({
        remoteBranch: { kind: "present" },
        pullRequest: { kind: "merged", number: 42, url: "https://github.com/x/y/pull/42" },
      }),
    );

    expect(actual.kind).toBe("pr-merged");
  });

  it("row 5 — terminal + clean worktree + local branch only → recoverable (push + pr create)", () => {
    const actual = decideVerdict(
      makeInput({
        worktree: { kind: "present-clean" },
        localBranch: { kind: "present", ahead: 3, behind: 0 },
        worktreeDir: "/work/repo-hrd-1",
      }),
    );

    assertRecoverable(actual);
    expect(actual.nextStep).toMatch(/git push -u origin paul-hrd-1.*gh pr create/);
  });

  it("row 6 — terminal + dirty worktree → recoverable (commit first)", () => {
    const actual = decideVerdict(
      makeInput({
        worktree: { kind: "present-dirty", modified: 2, untracked: 1 },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
      }),
    );

    assertRecoverable(actual);
    expect(actual.reason).toMatch(/dirty|uncommitted/);
  });

  it("row 7 — non-terminal + present worktree → in-flight", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-clean" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
        workspaceName: "hrd-1",
      }),
    );

    assertInFlight(actual);
    expect(actual.reason).toMatch(/hrd-1/);
  });

  it("row 8 — absent worktree but local branch exists → recoverable (stranded branch)", () => {
    const actual = decideVerdict(
      makeInput({
        worktree: { kind: "absent" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
      }),
    );

    assertRecoverable(actual);
    expect(actual.reason).toMatch(/stranded local branch/);
  });

  it("row 9 — any state + open PR with no local trace → pr-open with note", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        pullRequest: { kind: "open", number: 7, url: "https://github.com/x/y/pull/7" },
      }),
    );

    expect(actual.kind).toBe("pr-open");
  });
});
