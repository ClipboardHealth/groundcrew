/**
 * Routing and ordering (contracts §4.3, §7). Agent resolution is
 * `task.agent → sources[].agent → agents.default`; an id that resolves to a name
 * with no matching profile is treated as unrouted (ineligible), never a crash.
 * Eligible tasks are ordered by priority descending, stable within a source
 * (the source's list order breaks ties).
 */

import type { AgentProfileConfig } from "../session/index.js";
import type { AgentRouting, DispatchSource, SourcedTask } from "./types.js";

/** A resolved routing decision: the profile name and its config. */
export interface ResolvedAgent {
  name: string;
  profile: AgentProfileConfig;
}

/**
 * Resolves the agent profile for a task. `override` is `--agent`; it wins over
 * the task's own designation. Returns `undefined` when nothing routes (the
 * fields are absent) or the resolved name has no profile — both are "unrouted".
 */
export function resolveAgent(input: {
  task: { agent?: string | undefined };
  source: DispatchSource;
  agents: AgentRouting;
  override?: string;
}): ResolvedAgent | undefined {
  const name =
    input.override ?? input.task.agent ?? input.source.defaultAgent ?? input.agents.default;
  if (name === undefined || name === "") {
    return undefined;
  }

  const profile = input.agents.profiles[name];
  if (profile === undefined) {
    return undefined;
  }

  return { name, profile };
}

/** Priority for ordering; an absent priority sorts as the lowest (0). */
function priorityOf(task: { priority?: number | undefined }): number {
  return task.priority ?? 0;
}

/**
 * Orders sourced tasks by priority descending, stable otherwise (contracts §4.3).
 * `toSorted` with an index tiebreak keeps the source's list order for equal
 * priorities without mutating the input.
 */
export function orderByPriority(tasks: readonly SourcedTask[]): SourcedTask[] {
  return tasks
    .map((entry, index) => ({ entry, index }))
    .toSorted((left, right) => {
      const byPriority = priorityOf(right.entry.task) - priorityOf(left.entry.task);
      return byPriority === 0 ? left.index - right.index : byPriority;
    })
    .map((wrapped) => wrapped.entry);
}
