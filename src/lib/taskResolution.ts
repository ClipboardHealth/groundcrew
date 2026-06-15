import { naturalIdFromCanonical, type Task, type TaskSource } from "./taskSource.ts";

type TaskMatchKind = "exact" | "prefix" | "none";

export interface TaskResolutionMatches {
  matches: Task[];
  rejections: unknown[];
  matchKind: TaskMatchKind;
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
  if (prefix.matches.length > 0) {
    return { matches: prefix.matches, rejections, matchKind: "prefix" };
  }
  return { matches: [], rejections, matchKind: "none" };
}

async function collectExactTaskMatches({
  sources,
  naturalId,
}: CollectExactTaskMatchesArguments): Promise<Omit<TaskResolutionMatches, "matchKind">> {
  const results = await Promise.allSettled(
    sources.map(async (source) => await source.getTask(naturalId)),
  );
  const matches: Task[] = [];
  const rejections: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value !== null) {
        matches.push(result.value);
      }
      continue;
    }
    rejections.push(result.reason);
  }
  return { matches, rejections };
}

async function collectPrefixTaskMatches({
  sources,
  naturalIdPrefix,
}: CollectPrefixTaskMatchesArguments): Promise<Omit<TaskResolutionMatches, "matchKind">> {
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const tasks = await source.listTasks();
      return tasks.filter((task) => taskMatchesNaturalIdPrefix({ task, naturalIdPrefix }));
    }),
  );
  const matches: Task[] = [];
  const rejections: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      matches.push(...result.value);
      continue;
    }
    rejections.push(result.reason);
  }
  return { matches, rejections };
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
