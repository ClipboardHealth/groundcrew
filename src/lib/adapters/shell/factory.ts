/**
 * Shell-adapter `TaskSource` factory. Wires `invokeShellCommand` to the
 * TaskSource operations and applies the ShellIssue Zod schema for runtime
 * validation of script stdout.
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
 *  - `createTask` absent → method omitted entirely (source reports it cannot
 *    create tasks; the optional method is attached only when configured).
 *  - `validate` absent → method omitted entirely (same capability-detection
 *    contract as createTask).
 *  - `fetch` is required by the Zod schema.
 */

import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  type CreateTaskInput,
  toCanonicalId,
  type Blocker as CanonicalBlocker,
  type Issue as CanonicalIssue,
  type MarkDoneResult,
  type MarkInReviewResult,
  type TaskSource,
} from "../../taskSource.ts";
import { errorMessage, writeError } from "../../util.ts";

import { invokeShellCommand } from "./invoke.ts";
import { parseShellJson } from "./parseOutput.ts";
import {
  type ShellAdapterConfig,
  shellFetchOutputSchema,
  type ShellIssue,
  shellIssueSchema,
  shellValidateOutputSchema,
} from "./schema.ts";

interface ResolvedShellTimeouts {
  verify: number;
  listTasks: number;
  getTask: number;
  markInProgress: number;
  markInReview: number;
  markDone: number;
  createTask: number;
  validate: number;
}

const DEFAULT_TIMEOUTS: ResolvedShellTimeouts = {
  verify: 10_000,
  listTasks: 30_000,
  getTask: 10_000,
  markInProgress: 10_000,
  markInReview: 10_000,
  markDone: 10_000,
  createTask: 30_000,
  validate: 30_000,
};

function mergeTimeouts(overrides: ShellAdapterConfig["timeouts"]): ResolvedShellTimeouts {
  const o = overrides ?? {};
  return {
    verify: o.verify ?? DEFAULT_TIMEOUTS.verify,
    listTasks: o.listTasks ?? o.fetch ?? DEFAULT_TIMEOUTS.listTasks,
    getTask: o.getTask ?? o.resolveOne ?? DEFAULT_TIMEOUTS.getTask,
    markInProgress: o.markInProgress ?? DEFAULT_TIMEOUTS.markInProgress,
    markInReview: o.markInReview ?? DEFAULT_TIMEOUTS.markInReview,
    markDone: o.markDone ?? DEFAULT_TIMEOUTS.markDone,
    createTask: o.createTask ?? DEFAULT_TIMEOUTS.createTask,
    validate: o.validate ?? DEFAULT_TIMEOUTS.validate,
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
    agent: shellIssue.agent ?? undefined,
    assignee: shellIssue.assignee,
    updatedAt: shellIssue.updatedAt,
    blockers,
    hasMoreBlockers: shellIssue.hasMoreBlockers,
    ...(shellIssue.url === undefined ? {} : { url: shellIssue.url }),
    sourceRef: shellIssue.sourceRef,
  };
}

/**
 * Flatten a CreateTaskInput into the `${...}` substitution map the createTask
 * script receives. Every key is always present — absent optionals become an
 * empty string — so no placeholder is ever left literally in the command.
 * List fields are comma-joined into a single value.
 */
function createTaskSubstitutions(input: CreateTaskInput): Record<string, string> {
  return {
    title: input.title,
    agent: input.agent,
    // Exposed under both `repo` (short form) and `repository` (matches the
    // CreateTaskInput field name) so either placeholder resolves.
    repo: input.repository ?? "",
    repository: input.repository ?? "",
    team: input.team ?? "",
    id: input.id ?? "",
    priority: input.priority ?? "",
    due: input.due ?? "",
    recurrence: input.recurrence ?? "",
    promptFile: input.promptFile ?? "",
    description: input.description ?? "",
    edit: input.edit ? "true" : "",
    projects: input.projects.join(","),
    contexts: input.contexts.join(","),
    dependencies: input.dependencies.join(","),
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
    const parsed = parseShellJson(shellFetchOutputSchema, stdout, {
      sourceName,
      command: "listTasks",
    });
    return parsed.map((si) => toCanonicalIssue(si, sourceName));
  }

  async function getTask(naturalId: string): Promise<CanonicalIssue | null> {
    const canonicalId = toCanonicalId(sourceName, naturalId);
    if (getTaskCommand === undefined) {
      const all = await runFetch();
      return all.find((i) => i.id === canonicalId) ?? null;
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
      return null;
    }
    const parsed = parseShellJson(shellIssueSchema, result.stdout, {
      sourceName,
      command: "getTask",
    });
    return toCanonicalIssue(parsed, sourceName);
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

  const source: TaskSource = {
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
    async listTasks(): Promise<CanonicalIssue[]> {
      return await runFetch();
    },
    async getTask(naturalId: string): Promise<CanonicalIssue | null> {
      return await getTask(naturalId);
    },
    fetch: runFetch,
    async resolveOne(naturalId: string): Promise<CanonicalIssue | undefined> {
      return (await getTask(naturalId)) ?? undefined;
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

  // createTask / validate are attached only when their command is configured.
  // Capability detection keys off `source.createTask === undefined` /
  // `source.validate === undefined`, so a slot left unset must leave the
  // method genuinely absent rather than present-but-failing.
  const createTaskCommand = config.commands.createTask;
  if (createTaskCommand !== undefined) {
    source.createTask = async (input: CreateTaskInput): Promise<CanonicalIssue> => {
      const { stdout, exitCode } = await invokeShellCommand({
        command: createTaskCommand,
        timeoutMs: timeouts.createTask,
        cwd: config.cwd,
        env: config.env,
        substitutions: createTaskSubstitutions(input),
        sourceName,
      });
      // invokeShellCommand resolves (does not throw) on exit 3 — its "not
      // found" sentinel for lookups. Creation has no not-found concept, so any
      // nonzero exit is a failure: surface it rather than parse partial output.
      if (exitCode === 3) {
        throw new Error(
          `shell source "${sourceName}" createTask command exited 3 (not-found); task creation cannot signal not-found`,
        );
      }
      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        throw new Error(
          `shell source "${sourceName}" createTask command produced no output (expected one ShellIssue JSON)`,
        );
      }
      const parsed = parseShellJson(shellIssueSchema, trimmed, {
        sourceName,
        command: "createTask",
      });
      return toCanonicalIssue(parsed, sourceName);
    };
  }

  const validateCommand = config.commands.validate;
  if (validateCommand !== undefined) {
    source.validate = async (): Promise<string[]> => {
      try {
        const { stdout, exitCode } = await invokeShellCommand({
          command: validateCommand,
          timeoutMs: timeouts.validate,
          cwd: config.cwd,
          env: config.env,
          sourceName,
        });
        // exit 3 is invoke's lookup "not found" sentinel; for validation it is
        // not a meaningful success, so surface it as a failure (and validate
        // never throws — return the failure as an error string).
        if (exitCode === 3) {
          return [
            `shell source "${sourceName}" validate command exited 3 (not-found); treating as a validation failure`,
          ];
        }
        const trimmed = stdout.trim();
        if (trimmed.length === 0) {
          return [];
        }
        return shellValidateOutputSchema.parse(JSON.parse(trimmed));
      } catch (error) {
        // Contract: validate() never throws — fold a nonzero exit, timeout,
        // malformed JSON, or wrong-shape payload into a single error string.
        return [`shell source "${sourceName}" validate command failed: ${errorMessage(error)}`];
      }
    };
  }

  return source;
}
