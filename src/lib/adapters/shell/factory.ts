/**
 * Shell-adapter `TaskSource` factory. Wires `invokeShellCommand` to the
 * four TaskSource operations and applies the ShellIssue Zod schema for
 * runtime validation of script stdout.
 *
 * Fallback behavior for omitted commands:
 *  - `verify` absent → no-op (always succeeds).
 *  - `resolveOne` absent → invoke `fetch` and scan its result for the natural
 *    id. This means each fallback resolveOne pays a full fetch — fine for
 *    most CLI use (crew setup is rare) but users with expensive fetch
 *    commands should configure `resolveOne` explicitly. No cross-call cache
 *    in MVP-2.
 *  - `markInProgress` absent → silent no-op.
 *  - `markInReview` absent → reports unsupported.
 *  - `markDone` absent → reports unsupported.
 *  - `fetch` is required by the Zod schema.
 */

import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  toCanonicalId,
  type Blocker as CanonicalBlocker,
  type Issue as CanonicalIssue,
  type MarkDoneResult,
  type MarkInReviewResult,
  type TaskSource,
} from "../../taskSource.ts";

import { invokeShellCommand } from "./invoke.ts";
import {
  type ShellAdapterConfig,
  shellFetchOutputSchema,
  type ShellIssue,
  shellIssueSchema,
} from "./schema.ts";

interface ResolvedShellTimeouts {
  verify: number;
  fetch: number;
  resolveOne: number;
  markInProgress: number;
  markInReview: number;
  markDone: number;
}

const DEFAULT_TIMEOUTS: ResolvedShellTimeouts = {
  verify: 10_000,
  fetch: 30_000,
  resolveOne: 10_000,
  markInProgress: 10_000,
  markInReview: 10_000,
  markDone: 10_000,
};

function mergeTimeouts(overrides: ShellAdapterConfig["timeouts"]): ResolvedShellTimeouts {
  return {
    verify: overrides?.verify ?? DEFAULT_TIMEOUTS.verify,
    fetch: overrides?.fetch ?? DEFAULT_TIMEOUTS.fetch,
    resolveOne: overrides?.resolveOne ?? DEFAULT_TIMEOUTS.resolveOne,
    markInProgress: overrides?.markInProgress ?? DEFAULT_TIMEOUTS.markInProgress,
    markInReview: overrides?.markInReview ?? DEFAULT_TIMEOUTS.markInReview,
    markDone: overrides?.markDone ?? DEFAULT_TIMEOUTS.markDone,
  };
}

export function toCanonicalIssue(shellIssue: ShellIssue, sourceName: string): CanonicalIssue {
  const blockers: CanonicalBlocker[] = shellIssue.blockers.map((b) => ({
    id: toCanonicalId(sourceName, b.id),
    title: b.title,
    status: b.status,
    ...(b.statusReason !== undefined && { statusReason: b.statusReason }),
    ...(b.nativeStatus !== undefined && { nativeStatus: b.nativeStatus }),
  }));
  return {
    id: toCanonicalId(sourceName, shellIssue.id),
    source: sourceName,
    title: shellIssue.title,
    description: shellIssue.description,
    status: shellIssue.status,
    repository: shellIssue.repository ?? undefined,
    model: shellIssue.model ?? undefined,
    assignee: shellIssue.assignee,
    updatedAt: shellIssue.updatedAt,
    blockers,
    hasMoreBlockers: shellIssue.hasMoreBlockers,
    ...(shellIssue.url === undefined ? {} : { url: shellIssue.url }),
    sourceRef: shellIssue.sourceRef,
  };
}

export function createShellTaskSource(
  config: ShellAdapterConfig,
  _context: AdapterContext,
): TaskSource {
  const sourceName = config.name;
  const timeouts = mergeTimeouts(config.timeouts);

  async function runFetch(): Promise<CanonicalIssue[]> {
    const { stdout } = await invokeShellCommand({
      command: config.commands.fetch,
      timeoutMs: timeouts.fetch,
      cwd: config.cwd,
      env: config.env,
      sourceName,
    });
    const parsed = shellFetchOutputSchema.parse(JSON.parse(stdout));
    return parsed.map((si) => toCanonicalIssue(si, sourceName));
  }

  // Shared by markInProgress / markInReview: both pipe the canonical issue's
  // opaque sourceRef to a status-transition script on stdin, with the natural
  // and canonical ids substituted into the command.
  async function invokeWriteback(
    command: string | undefined,
    timeoutMs: number,
    issue: CanonicalIssue,
  ): Promise<void> {
    if (command === undefined) {
      return;
    }
    const naturalId = issue.id.startsWith(`${sourceName}:`)
      ? issue.id.slice(sourceName.length + 1)
      : issue.id;
    await invokeShellCommand({
      command,
      timeoutMs,
      cwd: config.cwd,
      env: config.env,
      substitutions: {
        id: naturalId,
        canonicalId: issue.id,
        name: sourceName,
      },
      stdin: JSON.stringify(issue.sourceRef),
      sourceName,
    });
  }

  return {
    name: sourceName,
    async verify(): Promise<void> {
      const verifyCommand = config.commands.verify;
      if (verifyCommand === undefined) {
        return;
      }
      await invokeShellCommand({
        command: verifyCommand,
        timeoutMs: timeouts.verify,
        cwd: config.cwd,
        env: config.env,
        sourceName,
      });
    },
    fetch: runFetch,
    async resolveOne(naturalId: string): Promise<CanonicalIssue | undefined> {
      const canonicalId = toCanonicalId(sourceName, naturalId);
      const resolveCommand = config.commands.resolveOne;
      if (resolveCommand === undefined) {
        const all = await runFetch();
        return all.find((i) => i.id === canonicalId);
      }
      const result = await invokeShellCommand({
        command: resolveCommand,
        timeoutMs: timeouts.resolveOne,
        cwd: config.cwd,
        env: config.env,
        substitutions: {
          id: naturalId,
          canonicalId,
          name: sourceName,
        },
        sourceName,
      });
      if (result.exitCode === 3 || result.stdout.trim().length === 0) {
        return undefined;
      }
      const parsed = shellIssueSchema.parse(JSON.parse(result.stdout));
      return toCanonicalIssue(parsed, sourceName);
    },
    async markInProgress(issue: CanonicalIssue): Promise<void> {
      await invokeWriteback(config.commands.markInProgress, timeouts.markInProgress, issue);
    },
    async markInReview(issue: CanonicalIssue): Promise<MarkInReviewResult> {
      if (config.commands.markInReview === undefined) {
        return {
          outcome: "unsupported",
          reason: `shell source "${sourceName}" has no commands.markInReview configured`,
        };
      }
      await invokeWriteback(config.commands.markInReview, timeouts.markInReview, issue);
      return { outcome: "applied" };
    },
    async markDone(issue: CanonicalIssue): Promise<MarkDoneResult> {
      if (config.commands.markDone === undefined) {
        return {
          outcome: "unsupported",
          reason: `shell source "${sourceName}" has no commands.markDone configured`,
        };
      }
      await invokeWriteback(config.commands.markDone, timeouts.markDone, issue);
      return { outcome: "applied" };
    },
  };
}
