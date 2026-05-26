/**
 * Board composer — fans `verify` / `fetch` / `resolveOne` / `markInProgress` /
 * `refreshBlockers` / `countInProgress` across N `TicketSource` adapters.
 * `sources()` exposes the underlying list for display iteration. Even a
 * single-source config goes through this; the moment we skip the wrapper we
 * grow Linear assumptions back into consumers.
 */

import {
  AmbiguousTicketError,
  type Blocker,
  type BoardState,
  type Issue,
  type ParentSkip,
  type TicketSource,
} from "./ticketSource.ts";

export interface Board {
  verify(): Promise<void>;
  fetch(): Promise<BoardState>;
  /**
   * Accepts either canonical (`linear:eng-220`) or natural (`eng-220`) ids.
   * Natural ids fan out across sources; ambiguous matches throw.
   */
  resolveOne(canonicalOrNaturalId: string): Promise<Issue | undefined>;
  /** Routes to the adapter whose `name` matches `issue.source`. Unknown source throws. */
  markInProgress(issue: Issue): Promise<void>;
  /**
   * Returns the source list in construction order. For consumers that
   * need to iterate sources by identity (e.g., ticketDoctor's per-source
   * summary). Cross-source operations should prefer the fan-out methods
   * (refreshBlockers, countInProgress, fetch, verify) — `sources()` is
   * the escape hatch, not the default API.
   */
  sources(): readonly TicketSource[];

  /**
   * Fan-out helper: dispatch to the issue's source's refreshBlockers (if
   * present); otherwise return issue.blockers as a fallback. Use this
   * instead of iterating sources() to keep callers source-agnostic.
   */
  refreshBlockers(issue: Issue): Promise<Blocker[]>;

  /**
   * Fan-out helper: sum countInProgress() across all sources. For sources
   * that don't implement countInProgress, falls back to fetching all of
   * that source's issues and counting "in-progress" in memory — equally
   * accurate but does a full fetch per call. Cache the result in hot paths
   * (e.g., the dispatcher's tick).
   */
  countInProgress(): Promise<number>;
}

async function callVerify(source: TicketSource): Promise<void> {
  await source.verify();
}

async function callFetch(source: TicketSource): Promise<Issue[]> {
  return await source.fetch();
}

async function callFetchParentSkips(source: TicketSource): Promise<readonly ParentSkip[]> {
  if (source.fetchParentSkips !== undefined) {
    return await source.fetchParentSkips();
  }
  return [];
}

async function callResolveOne(source: TicketSource, naturalId: string): Promise<Issue | undefined> {
  return await source.resolveOne(naturalId);
}

export function createBoard(sources: readonly TicketSource[]): Board {
  const byName = new Map<string, TicketSource>();
  for (const source of sources) {
    if (byName.has(source.name)) {
      throw new Error(
        `createBoard: duplicate source name "${source.name}". Each TicketSource must have a unique name so writebacks can route correctly. Configure distinct \`name\` fields in your \`sources: [...]\` array.`,
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
        return await callResolveOne(source, naturalId);
      }
      // Per-source resolveOne errors must not poison sibling resolutions.
      // A source that rejects on a natural-id lookup is treated as "I don't
      // have this ticket" (or "I can't say"). If any source resolved we use
      // it; only when none resolved AND at least one rejected do we surface
      // the rejection — so the user sees a real Linear/network error when
      // there's no fallback, but a stray "not found" from one source doesn't
      // mask a successful match from another.
      const results = await Promise.allSettled(
        sources.map(async (s) => await callResolveOne(s, idArgument)),
      );
      const matches: Issue[] = [];
      const rejections: unknown[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          rejections.push(result.reason);
          continue;
        }
        if (result.value !== undefined) {
          matches.push(result.value);
        }
      }
      if (matches.length === 0) {
        if (rejections.length > 0) {
          throw rejections[0];
        }
        return undefined;
      }
      if (matches.length === 1) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- length checked above
        return matches[0]!;
      }
      throw new AmbiguousTicketError({
        naturalId: idArgument,
        matches: matches.map((m) => m.id),
      });
    },

    async markInProgress(issue: Issue): Promise<void> {
      const source = byName.get(issue.source);
      if (!source) {
        throw new Error(`unknown source "${issue.source}" for issue ${issue.id}`);
      }
      await source.markInProgress(issue);
    },

    sources(): readonly TicketSource[] {
      return sources;
    },

    async refreshBlockers(issue: Issue): Promise<Blocker[]> {
      const entry = byName.get(issue.source);
      if (!entry) {
        throw new Error(`unknown source "${issue.source}" for issue ${issue.id}`);
      }
      if (entry.refreshBlockers !== undefined) {
        return await entry.refreshBlockers(issue);
      }
      return issue.blockers;
    },

    async countInProgress(): Promise<number> {
      const counts = await Promise.all(
        sources.map(async (s) => {
          if (s.countInProgress !== undefined) {
            return await s.countInProgress();
          }
          // Fallback: fetch all of this source's issues and count "in-progress" in memory.
          // Equally accurate to a native countInProgress() but downloads everything;
          // sources where this is hot should implement countInProgress? directly.
          const issues = await s.fetch();
          return issues.filter((issue) => issue.status === "in-progress").length;
        }),
      );
      return counts.reduce((sum, n) => sum + n, 0);
    },
  };
}
