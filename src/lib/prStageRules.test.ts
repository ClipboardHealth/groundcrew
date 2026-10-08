import {
  deriveTicket,
  derivePrStage,
  managedLabelsField,
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
