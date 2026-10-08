import {
  deriveTicket,
  derivePrStage,
  encodePrStatuses,
  isTaskBranch,
  managedLabelsField,
  mostUrgentStage,
  orderPullRequestStack,
  PR_STAGE_URGENCY_ORDER,
  selectShownPullRequests,
  selectTaskPullRequests,
  type PrStage,
  type PrStageInput,
  type TicketDerivationInput,
} from "./prStageRules.ts";

const LABEL_NAMES = { selfReviewed: "self-reviewed", tested: "tested" };

interface StageCase {
  name: string;
  input: PrStageInput;
  expected: PrStage;
}

// Ported 1:1 from crew-pr-stages.jq's fixtures/cases.json (17 cases) so the
// TypeScript port is held to the exact same behavior contract as the
// standalone poller it replaces.
const STAGE_CASES: readonly StageCase[] = [
  {
    name: "merged_beats_failing_checks",
    input: {
      state: "MERGED",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: "FAILURE",
    },
    expected: "merged",
  },
  {
    name: "closed",
    input: { state: "CLOSED", isDraft: false, labels: [], reviewDecision: null, checks: null },
    expected: "closed",
  },
  {
    name: "ci_failing",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: "FAILURE",
    },
    expected: "ci_failing",
  },
  {
    name: "ci_failing_error",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: "ERROR",
    },
    expected: "ci_failing",
  },
  {
    name: "ci_running_pending",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: null,
      checks: "PENDING",
    },
    expected: "ci_running",
  },
  {
    name: "ci_running_expected",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: null,
      checks: "EXPECTED",
    },
    expected: "ci_running",
  },
  {
    name: "my_review_draft_beats_everything_below",
    input: {
      state: "OPEN",
      isDraft: true,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    },
    expected: "my_review",
  },
  {
    name: "my_review_missing_self_reviewed_label",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["tested"],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    },
    expected: "my_review",
  },
  {
    name: "my_review_missing_both_labels",
    input: { state: "OPEN", isDraft: false, labels: [], reviewDecision: null, checks: "SUCCESS" },
    expected: "my_review",
  },
  {
    name: "needs_testing",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed"],
      reviewDecision: null,
      checks: "SUCCESS",
    },
    expected: "needs_testing",
  },
  {
    name: "needs_testing_beats_changes_requested",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed"],
      reviewDecision: "CHANGES_REQUESTED",
      checks: "SUCCESS",
    },
    expected: "needs_testing",
  },
  {
    name: "changes_requested",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "CHANGES_REQUESTED",
      checks: "SUCCESS",
    },
    expected: "changes_requested",
  },
  {
    name: "ready_to_merge",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    },
    expected: "ready_to_merge",
  },
  {
    name: "peer_review_review_required",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "REVIEW_REQUIRED",
      checks: "SUCCESS",
    },
    expected: "peer_review",
  },
  {
    name: "peer_review_null_review_decision",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: null,
      checks: "SUCCESS",
    },
    expected: "peer_review",
  },
  {
    name: "null_checks_treated_as_passing",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["self-reviewed", "tested"],
      reviewDecision: "APPROVED",
      checks: null,
    },
    expected: "ready_to_merge",
  },
  {
    name: "labels_among_others",
    input: {
      state: "OPEN",
      isDraft: false,
      labels: ["needs-changes", "self-reviewed", "tested", "urgent"],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    },
    expected: "ready_to_merge",
  },
];

describe(derivePrStage, () => {
  it.each(STAGE_CASES)("$name -> $expected", ({ input, expected }) => {
    expect(derivePrStage(input, LABEL_NAMES)).toBe(expected);
  });

  it("demonstrates the fixture can fail: an unreviewed draft is never ready_to_merge", () => {
    const input: PrStageInput = {
      state: "OPEN",
      isDraft: true,
      labels: [],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    };

    expect(derivePrStage(input, LABEL_NAMES)).not.toBe("ready_to_merge");
  });

  it("honors configured label names instead of the hardcoded defaults", () => {
    const input: PrStageInput = {
      state: "OPEN",
      isDraft: false,
      labels: ["reviewed-by-me", "qa-passed"],
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
    };

    expect(derivePrStage(input, { selfReviewed: "reviewed-by-me", tested: "qa-passed" })).toBe(
      "ready_to_merge",
    );
    expect(derivePrStage(input, LABEL_NAMES)).toBe("my_review");
  });
});

describe(managedLabelsField, () => {
  it("keeps only the two managed labels, sorted and comma-joined", () => {
    expect(
      managedLabelsField(["urgent", "tested", "needs-changes", "self-reviewed"], LABEL_NAMES),
    ).toBe("self-reviewed,tested");
  });

  it("returns empty when neither managed label is present", () => {
    expect(managedLabelsField(["urgent"], LABEL_NAMES)).toBe("");
  });

  it("returns a single label when only one is present", () => {
    expect(managedLabelsField(["tested"], LABEL_NAMES)).toBe("tested");
  });
});

interface TicketCase {
  name: string;
  input: TicketDerivationInput;
  expected: string | undefined;
}

// Ported 1:1 from crew-ticket.jq's fixtures/ticket-cases.json (8 cases).
const TICKET_CASES: readonly TicketCase[] = [
  {
    name: "ticket_from_directory_basename",
    input: {
      title: "do a thing",
      currentDirectory: "/Users/jason/.claude/worktrees/groundcrew-tg-4183",
    },
    expected: "TG-4183",
  },
  {
    name: "ticket_from_title_when_directory_has_none",
    input: {
      title: "TG-4183 fix the thing",
      currentDirectory: "/Users/jason/Documents/work/groundcrew",
    },
    expected: "TG-4183",
  },
  {
    name: "directory_wins_over_title",
    input: {
      title: "irrelevant title",
      currentDirectory: "/Users/jason/.claude/worktrees/groundcrew-tg-9001",
    },
    expected: "TG-9001",
  },
  {
    name: "no_ticket_anywhere",
    input: { title: "do a thing", currentDirectory: "/Users/jason/Documents/work/groundcrew" },
    expected: undefined,
  },
  {
    name: "title_prefix_too_long",
    input: { title: "TOOLONG-123 x", currentDirectory: "/tmp/x" },
    expected: undefined,
  },
  {
    name: "title_must_be_exactly_two_segments",
    input: { title: "not-a-ticket-9 do a thing", currentDirectory: "/Users/jason/Documents/work" },
    expected: undefined,
  },
  {
    name: "null_directory_falls_back_to_title",
    input: { title: "TG-42 pinned workbench", currentDirectory: null },
    expected: "TG-42",
  },
  {
    name: "lowercase_prefix_uppercased",
    input: { title: "tg-77 lowercase ticket", currentDirectory: "/tmp/x" },
    expected: "TG-77",
  },
];

describe(deriveTicket, () => {
  it.each(TICKET_CASES)("$name -> $expected", ({ input, expected }) => {
    expect(deriveTicket(input)).toBe(expected);
  });

  it("demonstrates the fixture can fail: a bare repo name is never a ticket", () => {
    expect(deriveTicket({ title: "x", currentDirectory: "/work/groundcrew" })).not.toBe(
      "GROUNDCREW",
    );
  });

  it("returns undefined when both title and directory are absent", () => {
    expect(deriveTicket({})).toBeUndefined();
  });
});

describe(isTaskBranch, () => {
  it("matches the exact task branch", () => {
    expect(isTaskBranch("jason-tg-4829", "jason-tg-4829")).toBe(true);
  });

  it("matches a branch stacked off the task branch", () => {
    expect(isTaskBranch("jason-tg-4829-limited-tier-read-gate", "jason-tg-4829")).toBe(true);
  });

  it("does not match a branch that merely shares a prefix without the hyphen boundary", () => {
    expect(isTaskBranch("jason-tg-48290-other-task", "jason-tg-4829")).toBe(false);
  });

  it("does not match an unrelated branch", () => {
    expect(isTaskBranch("main", "jason-tg-4829")).toBe(false);
  });
});

describe(mostUrgentStage, () => {
  it("picks my_review over every other stage", () => {
    expect(mostUrgentStage(["peer_review", "my_review", "merged"])).toBe("my_review");
  });

  it("ranks ci_failing above changes_requested", () => {
    expect(mostUrgentStage(["changes_requested", "ci_failing"])).toBe("ci_failing");
  });

  it("ranks merged and closed last", () => {
    expect(mostUrgentStage(["closed", "merged", "peer_review"])).toBe("peer_review");
  });

  it("returns the single stage given", () => {
    expect(mostUrgentStage(["ready_to_merge"])).toBe("ready_to_merge");
  });

  it("returns undefined for an empty list", () => {
    expect(mostUrgentStage([])).toBeUndefined();
  });

  it("enumerates every PrStage exactly once", () => {
    const allStages: readonly PrStage[] = [
      "merged",
      "closed",
      "ci_failing",
      "ci_running",
      "my_review",
      "needs_testing",
      "changes_requested",
      "ready_to_merge",
      "peer_review",
    ];
    expect([...PR_STAGE_URGENCY_ORDER].toSorted()).toStrictEqual([...allStages].toSorted());
  });
});

interface StackFixture {
  number: number;
  state: string;
  headRefName: string;
  baseRefName: string;
}

function stackPr(overrides: Partial<StackFixture> & { number: number }): StackFixture {
  return {
    state: "open",
    headRefName: `branch-${overrides.number}`,
    baseRefName: "main",
    ...overrides,
  };
}

describe(selectShownPullRequests, () => {
  it("shows every open and merged PR", () => {
    const open = stackPr({ number: 1, state: "open" });
    const merged = stackPr({ number: 2, state: "merged" });
    const closed = stackPr({ number: 3, state: "closed" });

    expect(selectShownPullRequests([open, merged, closed])).toStrictEqual([open, merged]);
  });

  it("falls back to closed PRs only when none are open or merged", () => {
    const closed = stackPr({ number: 1, state: "closed" });

    expect(selectShownPullRequests([closed])).toStrictEqual([closed]);
  });

  it("returns empty when there are no matched PRs at all", () => {
    expect(selectShownPullRequests([])).toStrictEqual([]);
  });
});

describe(orderPullRequestStack, () => {
  it("orders a clean stack bottom to top via baseRefName -> headRefName", () => {
    const bottom = stackPr({ number: 6195, headRefName: "read-gate", baseRefName: "main" });
    const middle = stackPr({
      number: 6196,
      headRefName: "notifications",
      baseRefName: "read-gate",
    });
    const top = stackPr({ number: 6197, headRefName: "shift-alert", baseRefName: "notifications" });

    expect(orderPullRequestStack([top, bottom, middle])).toStrictEqual([bottom, middle, top]);
  });

  it("returns the single PR unchanged", () => {
    const only = stackPr({ number: 1 });

    expect(orderPullRequestStack([only])).toStrictEqual([only]);
  });

  it("falls back to ascending PR number when there is more than one root", () => {
    const a = stackPr({ number: 2, headRefName: "a", baseRefName: "main" });
    const b = stackPr({ number: 1, headRefName: "b", baseRefName: "develop" });

    expect(orderPullRequestStack([a, b])).toStrictEqual([b, a]);
  });

  it("falls back to ascending PR number when a fork gives one PR two children", () => {
    const root = stackPr({ number: 3, headRefName: "r", baseRefName: "main" });
    const childA = stackPr({ number: 2, headRefName: "a", baseRefName: "r" });
    const childB = stackPr({ number: 1, headRefName: "b", baseRefName: "r" });

    expect(orderPullRequestStack([root, childA, childB])).toStrictEqual([childB, childA, root]);
  });

  it("falls back to ascending PR number when a disconnected pair leaves the single-root chain short of every PR", () => {
    const root = stackPr({ number: 3, headRefName: "r", baseRefName: "main" });
    const x = stackPr({ number: 2, headRefName: "x", baseRefName: "y" });
    const y = stackPr({ number: 1, headRefName: "y", baseRefName: "x" });

    expect(orderPullRequestStack([root, x, y])).toStrictEqual([y, x, root]);
  });
});

describe(selectTaskPullRequests, () => {
  it("matches the task's branch and its stack, shows open/merged, and orders bottom to top", () => {
    const unrelated = stackPr({ number: 1, headRefName: "other-task", baseRefName: "main" });
    const bottom = stackPr({
      number: 6195,
      headRefName: "jason-tg-4829-limited-tier-read-gate",
      baseRefName: "main",
    });
    const middle = stackPr({
      number: 6196,
      headRefName: "jason-tg-4829-limited-tier-notifications",
      baseRefName: "jason-tg-4829-limited-tier-read-gate",
    });
    const top = stackPr({
      number: 6197,
      headRefName: "jason-tg-4829-limited-tier-shift-alert",
      baseRefName: "jason-tg-4829-limited-tier-notifications",
    });
    const supersededClosed = stackPr({
      number: 6176,
      state: "closed",
      headRefName: "jason-tg-4829",
      baseRefName: "main",
    });

    const actual = selectTaskPullRequests(
      [unrelated, top, supersededClosed, bottom, middle],
      "jason-tg-4829",
    );

    expect(actual).toStrictEqual([bottom, middle, top]);
  });

  it("falls back to the closed PR when the task has no open or merged PR", () => {
    const closed = stackPr({ number: 6176, state: "closed", headRefName: "jason-tg-4829" });

    expect(selectTaskPullRequests([closed], "jason-tg-4829")).toStrictEqual([closed]);
  });

  it("returns empty when the task has no matching PR at all", () => {
    const other = stackPr({ number: 1, headRefName: "someone-else-task" });

    expect(selectTaskPullRequests([other], "jason-tg-4829")).toStrictEqual([]);
  });
});

describe(encodePrStatuses, () => {
  it("encodes no entries as an empty string", () => {
    expect(encodePrStatuses([])).toBe("");
  });

  it("encodes one entry as number,stage,url", () => {
    expect(
      encodePrStatuses([
        { number: 6195, stage: "ready_to_merge", url: "https://github.com/acme/x/pull/6195" },
      ]),
    ).toBe("6195,ready_to_merge,https://github.com/acme/x/pull/6195");
  });

  it("joins multiple entries with ;", () => {
    expect(
      encodePrStatuses([
        { number: 1, stage: "my_review", url: "https://github.com/acme/x/pull/1" },
        { number: 2, stage: "peer_review", url: "https://github.com/acme/x/pull/2" },
      ]),
    ).toBe(
      "1,my_review,https://github.com/acme/x/pull/1;2,peer_review,https://github.com/acme/x/pull/2",
    );
  });
});
