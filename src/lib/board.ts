/**
 * Board composer — fans `verify` / `listTasks` / `getTask` / `markInProgress` /
 * `markInReview` across N `TaskSource` adapters. Even a single-source config
 * goes through this; the moment we skip the wrapper we grow Linear assumptions
 * back into consumers.
 */

import {
  AmbiguousTaskError,
  type BoardState,
  type Issue,
  type MarkDoneResult,
  type MarkInReviewResult,
  type ParentSkip,
  type TaskSource,
} from "./taskSource.ts";
import { resolveTaskIdMatches, type TaskResolutionMatches } from "./taskResolution.ts";

export interface Board {
  verify: () => Promise<void>;
  fetch: () => Promise<BoardState>;
  /**
   * Accepts either canonical (`linear:eng-220`) or natural (`eng-220`) ids,
   * plus unique prefixes of current listed tasks. Natural ids fan out across
   * sources; ambiguous matches throw.
   */
  resolveOne: (canonicalOrNaturalId: string) => Promise<Issue | undefined>;
  /** Routes to the adapter whose `name` matches `issue.source`. Unknown source throws. */
  markInProgress: (issue: Issue) => Promise<void>;
  /**
   * Advances a task to in-review on the adapter whose `name` matches
   * `issue.source`. Unknown source throws. Adapters with no in-review concept
   * return `unsupported` (see `TaskSource.markInReview`).
   */
  markInReview: (issue: Issue) => Promise<MarkInReviewResult>;
  /**
   * Advances a task to done on the adapter whose `name` matches
   * `issue.source`. Unknown source throws. Sources that don't implement the
   * optional `markDone` return `unsupported` (see `TaskSource.markDone`).
   */
  markDone: (issue: Issue) => Promise<MarkDoneResult>;
}

async function callVerify(source: TaskSource): Promise<void> {
  await source.verify();
}

async function callFetch(source: TaskSource): Promise<Issue[]> {
  return await source.listTasks();
}

async function callFetchParentSkips(source: TaskSource): Promise<readonly ParentSkip[]> {
  if (source.fetchParentSkips !== undefined) {
    return await source.fetchParentSkips();
  }
  return [];
}

interface UniqueResolvedIssueArguments {
  idArgument: string;
  resolution: TaskResolutionMatches;
}

function uniqueResolvedIssue({
  idArgument,
  resolution,
}: UniqueResolvedIssueArguments): Issue | undefined {
  if (resolution.matches.length === 0) {
    if (resolution.rejections.length > 0) {
      throw resolution.rejections[0];
    }
    return undefined;
  }
  if (resolution.matches.length === 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- length checked above
    return resolution.matches[0]!;
  }
  throw new AmbiguousTaskError({
    naturalId: idArgument,
    matches: resolution.matches.map((match) => match.id),
  });
}

export function createBoard(sources: readonly TaskSource[]): Board {
  const byName = new Map<string, TaskSource>();
  for (const source of sources) {
    if (byName.has(source.name)) {
      throw new Error(
        `createBoard: duplicate source name "${source.name}". Each TaskSource must have a unique name so writebacks can route correctly. Configure distinct \`name\` fields in your \`sources: [...]\` array.`,
      );
    }
    byName.set(source.name, source);
  }

  return {
    async verify(): Promise<void> {
      const results = await Promise.allSettled(sources.map(callVerify));
      const failures: string[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          // oxlint-disable-next-line typescript/no-non-null-assertion -- index drawn from results.entries(), guaranteed valid
          failures.push(`source "${sources[index]!.name}" failed verify: ${reason}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(failures.join("\n"));
      }
    },

    async fetch(): Promise<BoardState> {
      // Per-source serialization: each source's callFetch must complete
      // before its callFetchParentSkips so adapters that cache parent skips
      // as a side effect of fetch() (e.g. Linear, which stores them on
      // `lastParentSkips`) don't serve stale or empty data. Outer Promise.all
      // keeps cross-source fan-out concurrent.
      const perSource = await Promise.all(
        sources.map(async (source) => {
          const issues = await callFetch(source);
          const parentSkips = await callFetchParentSkips(source);
          return { issues, parentSkips };
        }),
      );
      return {
        timestamp: new Date().toISOString(),
        issues: perSource.flatMap((entry) => entry.issues),
        parentSkips: perSource.flatMap((entry) => entry.parentSkips),
      };
    },

    async resolveOne(idArgument: string): Promise<Issue | undefined> {
      const colonIndex = idArgument.indexOf(":");
      if (colonIndex !== -1) {
        const sourceName = idArgument.slice(0, colonIndex);
        const naturalId = idArgument.slice(colonIndex + 1);
        const source = byName.get(sourceName);
        if (!source) {
          throw new Error(`unknown source "${sourceName}" in canonical id "${idArgument}"`);
        }
        return uniqueResolvedIssue({
          idArgument,
          resolution: await resolveTaskIdMatches({ sources: [source], naturalId }),
        });
      }
      // Per-source resolveOne errors must not poison sibling resolutions.
      // A source that rejects on a natural-id lookup is treated as "I don't
      // have this task" (or "I can't say"). If any source resolved we use
      // it; only when none resolved AND at least one rejected do we surface
      // the rejection — so the user sees a real Linear/network error when
      // there's no fallback, but a stray "not found" from one source doesn't
      // mask a successful match from another.
      return uniqueResolvedIssue({
        idArgument,
        resolution: await resolveTaskIdMatches({ sources, naturalId: idArgument }),
      });
    },

    async markInProgress(issue: Issue): Promise<void> {
      await routeWriteback(byName, issue).markInProgress(issue);
    },

    async markInReview(issue: Issue): Promise<MarkInReviewResult> {
      return await routeWriteback(byName, issue).markInReview(issue);
    },

    async markDone(issue: Issue): Promise<MarkDoneResult> {
      const source = routeWriteback(byName, issue);
      if (source.markDone === undefined) {
        return {
          outcome: "unsupported",
          reason: `source "${source.name}" does not support markDone`,
        };
      }
      return await source.markDone(issue);
    },
  };
}

/**
 * Resolve the adapter that owns `issue` for a writeback, by its `source` name.
 * Shared by `markInProgress` / `markInReview` so both route — and fail —
 * identically. Throws when no adapter claims the source.
 */
function routeWriteback(byName: Map<string, TaskSource>, issue: Issue): TaskSource {
  const source = byName.get(issue.source);
  if (!source) {
    throw new Error(`unknown source "${issue.source}" for issue ${issue.id}`);
  }
  return source;
}
