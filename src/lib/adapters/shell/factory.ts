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
import { writeError } from "../../util.ts";

import { invokeShellCommand } from "./invoke.ts";
import {
  type ShellAdapterConfig,
  shellFetchOutputSchema,
  type ShellIssue,
  shellIssueSchema,
} from "./schema.ts";

interface ResolvedShellTimeouts {
  verify: number;
  listTasks: number;
  getTask: number;
  markInProgress: number;
  markInReview: number;
  markDone: number;
}

const DEFAULT_TIMEOUTS: ResolvedShellTimeouts = {
  verify: 10_000,
  listTasks: 30_000,
  getTask: 10_000,
  markInProgress: 10_000,
  markInReview: 10_000,
  markDone: 10_000,
};

function mergeTimeouts(overrides: ShellAdapterConfig["timeouts"]): ResolvedShellTimeouts {
  return {
    verify: overrides?.verify ?? DEFAULT_TIMEOUTS.verify,
    listTasks: overrides?.listTasks ?? overrides?.fetch ?? DEFAULT_TIMEOUTS.listTasks,
    getTask: overrides?.getTask ?? overrides?.resolveOne ?? DEFAULT_TIMEOUTS.getTask,
    markInProgress: overrides?.markInProgress ?? DEFAULT_TIMEOUTS.markInProgress,
    markInReview: overrides?.markInReview ?? DEFAULT_TIMEOUTS.markInReview,
    markDone: overrides?.markDone ?? DEFAULT_TIMEOUTS.markDone,
  };
}

function warnDuplicate(sourceName: string, preferred: string, legacy: string): void {
  writeError(
    `shell source "${sourceName}": commands.${preferred} and commands.${legacy} are both set; commands.${legacy} is ignored (use commands.${preferred})`,
  );
}

/** Preferred name preferred over legacy alias. Throws if neither is set (Zod schema invariant). */
function resolveListTasksCommand(
  commands: ShellAdapterConfig["commands"],
  sourceName: string,
): string {
  const { listTasks, fetch } = commands;
  if (listTasks !== undefined && fetch !== undefined) {
    warnDuplicate(sourceName, "listTasks", "fetch");
  }
  const resolved = listTasks ?? fetch;
  /* v8 ignore next @preserve -- Zod superRefine guarantees at least one is set */
  if (resolved === undefined) {
    throw new Error(`shell source "${sourceName}": commands.listTasks is required`);
  }
  return resolved;
}

/** Preferred name preferred over legacy alias. Returns undefined when neither is set. */
function resolveGetTaskCommand(
  commands: ShellAdapterConfig["commands"],
  sourceName: string,
): string | undefined {
  const { getTask, resolveOne } = commands;
  if (getTask !== undefined && resolveOne !== undefined) {
    warnDuplicate(sourceName, "getTask", "resolveOne");
  }
  return getTask ?? resolveOne;
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
  const listTasksCommand = resolveListTasksCommand(config.commands, sourceName);
  const getTaskCommand = resolveGetTaskCommand(config.commands, sourceName);

  async function runFetch(): Promise<CanonicalIssue[]> {
    const { stdout } = await invokeShellCommand({
      command: listTasksCommand,
      timeoutMs: timeouts.listTasks,
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
      if (getTaskCommand === undefined) {
        const all = await runFetch();
        return all.find((i) => i.id === canonicalId);
      }
      const result = await invokeShellCommand({
        command: getTaskCommand,
        timeoutMs: timeouts.getTask,
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
