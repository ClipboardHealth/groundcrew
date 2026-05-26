/**
 * Integration tests for the doctor + real Board fan-out.
 *
 * The rest of the doctor's test surface (ticketDoctor.test.ts) uses
 * `makeBoard()` from testHelpers — a vi-mocked stub. That covers the
 * doctor's per-section logic but blind-spots the seam where the doctor
 * calls `board.resolveOne` and consumes the real fan-out semantics.
 *
 * The bugs fixed by 4c93d8e + e78564a (shell-adapter canonical-id case
 * mismatch + Promise.all poisoning resolveOne) lived in exactly that
 * seam. Fake-board tests passed while the user's
 * `crew doctor --ticket TEST-1` failed end-to-end. These tests
 * instantiate a real `createBoard([...stubSources])` and run
 * `ticketDoctor()` against it, asserting the doctor sees what the real
 * Board returns.
 */

import { createBoard } from "../lib/board.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import type { RunState } from "../lib/runState.ts";
import { canonicalShellIssue } from "../lib/testing/canonicalFixtures.ts";
import type { Issue, TicketSource } from "../lib/ticketSource.ts";
import type { WorkspaceAccessHint, WorkspaceProbe } from "../lib/workspaces.ts";
import type { WorktreeDirtiness, WorktreeEntry } from "../lib/worktrees.ts";
import {
  ticketDoctor,
  type LocalBranchProbe,
  type PullRequestProbe,
  type RemoteBranchProbe,
  type TicketDoctorDependencies,
} from "./ticketDoctor.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projects: [
        {
          projectSlug: "ai-strategy-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
      ...overrides.linear,
    },
    sources: [],
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    models: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", ...overrides.local },
    sandbox: { authRecipes: {}, gitDefaults: false, ...overrides.sandbox },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function stubSource(name: string, overrides: Partial<TicketSource> = {}): TicketSource {
  return {
    name,
    verify: vi.fn<TicketSource["verify"]>().mockResolvedValue(),
    fetch: vi.fn<TicketSource["fetch"]>().mockResolvedValue([]),
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires a value
    resolveOne: vi.fn<TicketSource["resolveOne"]>().mockResolvedValue(undefined),
    markInProgress: vi.fn<TicketSource["markInProgress"]>().mockResolvedValue(),
    ...overrides,
  };
}

/**
 * Builds the doctor deps shared across these tests. The Board is the only
 * dep that varies per test; everything else stays at "nothing on disk,
 * no Linear enrichment" so the test assertions can focus on the seam
 * between doctor and Board.
 */
function makeDoctorDeps(
  ticket: string,
  board: TicketDoctorDependencies["board"],
  overrides: Partial<TicketDoctorDependencies> = {},
): TicketDoctorDependencies {
  return {
    config: makeConfig(),
    ticket,
    // Suppress Linear enrichment so the universal flow's behavior with the
    // Board's return value is what we measure. Tests that want to exercise
    // the Linear-enrichment fallback path override this explicitly.
    enrichWithLinear: undefined,
    board,
    fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({}),
    findWorktree: () => undefined as WorktreeEntry | undefined,
    probeWorkspaces: vi
      .fn<TicketDoctorDependencies["probeWorkspaces"]>()
      .mockResolvedValue({ kind: "ok", names: new Set<string>() } satisfies WorkspaceProbe),
    workspaceAccessHint: async () => undefined as WorkspaceAccessHint | undefined,
    probeWorkingTree: vi
      .fn<TicketDoctorDependencies["probeWorkingTree"]>()
      .mockResolvedValue({ kind: "unknown" } satisfies WorktreeDirtiness),
    resolveDefaultBranch: vi
      .fn<TicketDoctorDependencies["resolveDefaultBranch"]>()
      .mockResolvedValue("main"),
    probeLocalBranch: vi
      .fn<TicketDoctorDependencies["probeLocalBranch"]>()
      .mockResolvedValue({ kind: "absent" } satisfies LocalBranchProbe),
    probeRemoteBranch: vi
      .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
      .mockResolvedValue({ kind: "absent" } satisfies RemoteBranchProbe),
    probePullRequest: vi
      .fn<TicketDoctorDependencies["probePullRequest"]>()
      .mockResolvedValue({ kind: "absent" } satisfies PullRequestProbe),
    readRunState: vi
      .fn<TicketDoctorDependencies["readRunState"]>()
      .mockReturnValue(undefined as RunState | undefined),
    doFetch: false,
    ...overrides,
  };
}

describe("ticketDoctor + real Board fan-out", () => {
  it("resolves a shell-source ticket when the Linear source rejects on resolveOne", async () => {
    // This is the exact scenario the user hit with `crew doctor --ticket TEST-1`:
    // Linear rejects "Entity not found" while the shell adapter has the ticket.
    // Pre-fix (Promise.all), Linear's rejection poisoned the fan-out and the
    // doctor reported "unresolvable". Post-fix, the shell match wins.
    const shellIssue: Issue = canonicalShellIssue({
      naturalId: "test-1",
      status: "todo",
      repository: "repo-a",
      model: "claude",
    });
    const linear = stubSource("linear", {
      resolveOne: vi
        .fn<TicketSource["resolveOne"]>()
        .mockRejectedValue(new Error("Entity not found: Issue - Could not find referenced Issue.")),
    });
    const shell = stubSource("shell-test", {
      resolveOne: vi.fn<TicketSource["resolveOne"]>().mockResolvedValue(shellIssue),
    });
    const board = createBoard([linear, shell]);
    const deps = makeDoctorDeps("test-1", board);

    const result = await ticketDoctor(deps);

    expect(result.verdict.kind).toBe("would-dispatch");
    expect(result.resolution[0]).toMatchObject({
      name: "Ticket exists in source shell-test",
      status: "ok",
    });
    // No "Linear" leaked into the rendered resolution section.
    const resolutionNames = result.resolution.map((c) => c.name).join("\n");
    expect(resolutionNames).not.toMatch(/Linear/i);
  });

  it("renders an unresolvable verdict when every source rejects on resolveOne", async () => {
    // Post-allSettled, board.resolveOne re-raises the first rejection when no
    // source matched. The doctor catches that and falls through to its
    // "no source returned an Issue" branch. This pins the silent-swallow
    // behavior so a future doctor refactor that surfaces the underlying
    // rejection in the verdict reason fails this test deliberately.
    const linear = stubSource("linear", {
      resolveOne: vi
        .fn<TicketSource["resolveOne"]>()
        .mockRejectedValue(new Error("Linear API: timeout")),
    });
    const shell = stubSource("shell-test", {
      resolveOne: vi
        .fn<TicketSource["resolveOne"]>()
        .mockRejectedValue(new Error("shell command exited 1")),
    });
    const board = createBoard([linear, shell]);
    const deps = makeDoctorDeps("nope-1", board);

    const result = await ticketDoctor(deps);

    expect(result.verdict.kind).toBe("unresolvable");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- safe after the kind check above
    const verdict = result.verdict as Extract<typeof result.verdict, { kind: "unresolvable" }>;
    expect(verdict.reason).toContain("not found in any configured source");
  });

  it("renders an unresolvable verdict when the ticket is ambiguous across sources", async () => {
    // Both sources resolve a Todo issue for the same natural id. The Board
    // throws AmbiguousTicketError; the doctor catches it and falls through.
    // Pins the current behavior. (Like the all-reject case, the underlying
    // ambiguity reason is silently lost — a future improvement could surface
    // it.)
    const linearIssue: Issue = {
      ...canonicalShellIssue({
        naturalId: "eng-1",
        sourceName: "linear",
        status: "todo",
        repository: "repo-a",
        model: "claude",
      }),
    };
    const shellIssue: Issue = canonicalShellIssue({
      naturalId: "eng-1",
      status: "todo",
      repository: "repo-a",
      model: "claude",
    });
    const linear = stubSource("linear", {
      resolveOne: vi.fn<TicketSource["resolveOne"]>().mockResolvedValue(linearIssue),
    });
    const shell = stubSource("shell-test", {
      resolveOne: vi.fn<TicketSource["resolveOne"]>().mockResolvedValue(shellIssue),
    });
    const board = createBoard([linear, shell]);
    const deps = makeDoctorDeps("eng-1", board);

    const result = await ticketDoctor(deps);

    expect(result.verdict.kind).toBe("unresolvable");
  });

  it("lowercases the input ticket id before delegating to board.resolveOne", async () => {
    // Regression: pre-casing-fix, the canonical-id mismatch hid behind upper
    // vs lower input handling. Doctor lowercases input (ticketDoctor.ts:1303
    // calls resolveOne(lowerTicket)) so adapters must be called with the
    // lowercased form. This test pins that contract by feeding the doctor an
    // uppercase ticket and asserting the shell source saw "test-1".
    const shellIssue: Issue = canonicalShellIssue({
      naturalId: "test-1",
      status: "todo",
      repository: "repo-a",
      model: "claude",
    });
    const shellResolveOne = vi.fn<TicketSource["resolveOne"]>().mockResolvedValue(shellIssue);
    const shell = stubSource("shell-test", { resolveOne: shellResolveOne });
    const board = createBoard([shell]);
    const deps = makeDoctorDeps("TEST-1", board);

    const result = await ticketDoctor(deps);

    expect(shellResolveOne).toHaveBeenCalledWith("test-1");
    expect(result.verdict.kind).toBe("would-dispatch");
  });
});
