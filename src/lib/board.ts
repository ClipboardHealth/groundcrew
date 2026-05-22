/**
 * Board composer — fans `verify` / `fetch` / `resolveOne` / `markInProgress`
 * across N `TicketSource` adapters. Even a single-source config goes through
 * this; the moment we skip the wrapper we grow Linear assumptions back into
 * consumers.
 */

import {
  AmbiguousTicketError,
  type BoardState,
  type Issue,
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
}

async function callVerify(source: TicketSource): Promise<void> {
  await source.verify();
}

async function callFetch(source: TicketSource): Promise<Issue[]> {
  return await source.fetch();
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
      const issuesPerSource = await Promise.all(sources.map(callFetch));
      return { timestamp: new Date().toISOString(), issues: issuesPerSource.flat() };
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
      const results = await Promise.all(
        sources.map(async (s) => await callResolveOne(s, idArgument)),
      );
      const matches = results.filter((r): r is Issue => r !== undefined);
      if (matches.length === 0) {
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
  };
}
