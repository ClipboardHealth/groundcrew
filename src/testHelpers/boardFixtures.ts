import type { Board } from "../lib/board.ts";
import type {
  AttachmentFetchResult,
  BoardState,
  MarkDoneResult,
  MarkInReviewResult,
} from "../lib/taskSource.ts";

export function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    verify: vi.fn<() => Promise<void>>().mockResolvedValue(),
    fetch: vi
      .fn<() => Promise<BoardState>>()
      .mockResolvedValue({ timestamp: "", issues: [], parentSkips: [] }),
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires a value for non-void return type
    resolveOne: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    markInProgress: vi.fn<() => Promise<void>>().mockResolvedValue(),
    markInReview: vi
      .fn<() => Promise<MarkInReviewResult>>()
      .mockResolvedValue({ outcome: "applied" }),
    markDone: vi.fn<() => Promise<MarkDoneResult>>().mockResolvedValue({ outcome: "applied" }),
    fetchAttachments: vi
      .fn<() => Promise<AttachmentFetchResult>>()
      .mockResolvedValue({ attachments: [] }),
    ...overrides,
  };
}
