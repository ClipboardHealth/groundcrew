import { naturalIdFromCanonical, type Task, type TaskSource } from "./taskSource.ts";

type TaskMatchKind = "exact" | "prefix" | "none";

export interface TaskResolutionMatches {
  matches: Task[];
  rejections: unknown[];
  sourceFailures: TaskSourceFailure[];
  matchKind: TaskMatchKind;
}

interface TaskSourceFailure {
  source: string;
  reason: unknown;
}

interface CollectExactTaskMatchesArguments {
  sources: readonly TaskSource[];
  naturalId: string;
}

interface CollectPrefixTaskMatchesArguments {
  sources: readonly TaskSource[];
  naturalIdPrefix: string;
}

interface TaskMatchesNaturalIdPrefixArguments {
  task: Task;
  naturalIdPrefix: string;
}

export async function resolveTaskIdMatches(
  arguments_: CollectExactTaskMatchesArguments,
): Promise<TaskResolutionMatches> {
  const exact = await collectExactTaskMatches(arguments_);
  if (exact.matches.length > 0) {
    return { ...exact, matchKind: "exact" };
  }

  const prefix = await collectPrefixTaskMatches({
    sources: arguments_.sources,
    naturalIdPrefix: arguments_.naturalId,
  });
  const rejections = [...exact.rejections, ...prefix.rejections];
  const sourceFailures = [...exact.sourceFailures, ...prefix.sourceFailures];
  if (prefix.matches.length > 0) {
    return { matches: prefix.matches, rejections, sourceFailures, matchKind: "prefix" };
  }
  return { matches: [], rejections, sourceFailures, matchKind: "none" };
}

async function collectExactTaskMatches({
  sources,
  naturalId,
}: CollectExactTaskMatchesArguments): Promise<Omit<TaskResolutionMatches, "matchKind">> {
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        return { kind: "ok" as const, task: await source.getTask(naturalId) };
      } catch (reason) {
        return { kind: "error" as const, source: source.name, reason };
      }
    }),
  );
  const matches: Task[] = [];
  const rejections: unknown[] = [];
  const sourceFailures: TaskSourceFailure[] = [];
  for (const result of results) {
    if (result.kind === "ok") {
      if (result.task !== null) {
        matches.push(result.task);
      }
      continue;
    }
    rejections.push(result.reason);
    sourceFailures.push({ source: result.source, reason: result.reason });
  }
  return { matches, rejections, sourceFailures };
}

async function collectPrefixTaskMatches({
  sources,
  naturalIdPrefix,
}: CollectPrefixTaskMatchesArguments): Promise<Omit<TaskResolutionMatches, "matchKind">> {
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const tasks = await source.listTasks();
        return {
          kind: "ok" as const,
          tasks: tasks.filter((task) => taskMatchesNaturalIdPrefix({ task, naturalIdPrefix })),
        };
      } catch (reason) {
        return { kind: "error" as const, source: source.name, reason };
      }
    }),
  );
  const matches: Task[] = [];
  const rejections: unknown[] = [];
  const sourceFailures: TaskSourceFailure[] = [];
  for (const result of results) {
    if (result.kind === "ok") {
      matches.push(...result.tasks);
      continue;
    }
    rejections.push(result.reason);
    sourceFailures.push({ source: result.source, reason: result.reason });
  }
  return { matches, rejections, sourceFailures };
}

function taskMatchesNaturalIdPrefix({
  task,
  naturalIdPrefix,
}: TaskMatchesNaturalIdPrefixArguments): boolean {
  if (naturalIdPrefix.length === 0) {
    return false;
  }
  return naturalIdFromCanonical(task.id).toLowerCase().startsWith(naturalIdPrefix.toLowerCase());
}
