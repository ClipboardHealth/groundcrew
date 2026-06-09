/**
 * Linear adapter — parsing helpers for agent/repository resolution from
 * issue labels and descriptions. Extracted from boardSource.ts (Task 10).
 */

import { AGENT_ANY, isBuiltInAgentNotEnabled, type ResolvedConfig } from "../../config.ts";
import { RepositoryResolutionError } from "../../taskSource.ts";

export const AGENT_LABEL_PREFIX = "agent-";

export type RepositoryResolution = { kind: "ok"; repository: string } | { kind: "missing" };

export type AgentResolution =
  | { kind: "matched"; agent: string }
  | { kind: "no-label" }
  | { kind: "agent-any" }
  | { kind: "not-enabled-fallback"; requestedAgent: string; fallbackAgent: string };

function escapeRegex(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

// Sort by descending length so longer names match first — `api-admin`
// must beat `api` when both are configured. `\b` treats `-` as a word
// boundary, so without this ordering `api` would win on `api-admin`.
export function buildRepositoryRegex(config: ResolvedConfig): RegExp {
  const candidates = config.workspace.knownRepositories.flatMap((repo) => {
    const slashIndex = repo.indexOf("/");
    return slashIndex === -1 ? [repo] : [repo, repo.slice(slashIndex + 1)];
  });
  const alternation = candidates
    .toSorted((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  return new RegExp(String.raw`\b(${alternation})\b`);
}

// Shared canonicalization for parseRepository (auto-pickup / dispatch path)
// and resolveRepositoryFor (manual setup / single-task path). The regex
// can capture either a full `owner/repo` or a bare `repo` when only that
// appears in the description; canonicalization resolves a bare match back
// to its full `owner/repo` entry in knownRepositories, and rejects bare
// names that map to multiple knownRepositories as ambiguous. Both callers
// share this so the two paths can't drift on what counts as a match.
type CanonicalizedRepositoryMatch =
  | { kind: "canonical"; repository: string }
  | { kind: "unknown"; repository: string }
  | { kind: "missing" }
  | { kind: "ambiguous" };

function canonicalizeRepositoryMatch(
  description: string | undefined,
  config: ResolvedConfig,
  repositoryRegex: RegExp,
): CanonicalizedRepositoryMatch {
  if (description === undefined || description.length === 0) {
    return { kind: "missing" };
  }
  // Guard against an empty knownRepositories config: buildRepositoryRegex
  // would produce /\b()\b/, which matches the empty string at any word
  // boundary and returns a bogus "" match. Treat that as "no repo could
  // be resolved" so neither the dispatch path nor the doctor path emits
  // a spurious empty-string repository.
  if (config.workspace.knownRepositories.length === 0) {
    return { kind: "missing" };
  }
  const matched = repositoryRegex.exec(description)?.[1];
  if (matched === undefined) {
    return { kind: "missing" };
  }
  const candidates = config.workspace.knownRepositories.filter(
    (r) => r === matched || r.endsWith(`/${matched}`),
  );
  if (candidates.length > 1) {
    return { kind: "ambiguous" };
  }
  if (candidates.length === 1) {
    /* v8 ignore next @preserve -- length-1 guarantees [0] defined */
    // oxlint-disable-next-line typescript/no-non-null-assertion -- length-1 guarantees [0] is defined
    return { kind: "canonical", repository: candidates[0]! };
  }
  return { kind: "unknown", repository: matched };
}

export function resolveRepositoryFor(arguments_: {
  description: string | undefined;
  config: ResolvedConfig;
}): RepositoryResolution {
  const { description, config } = arguments_;
  const match = canonicalizeRepositoryMatch(description, config, buildRepositoryRegex(config));
  switch (match.kind) {
    case "missing":
    case "ambiguous": {
      // Ambiguous matches surface as "missing" so fetchResolvedIssue throws
      // RepositoryResolutionError — same conflation parseRepository uses,
      // and the right call for single-task flows: the launcher can't
      // disambiguate "matched N known repos" any more than the dispatcher can.
      return { kind: "missing" };
    }
    case "canonical":
    case "unknown": {
      return { kind: "ok", repository: match.repository };
    }
    /* v8 ignore next 5 @preserve -- exhaustive over CanonicalizedRepositoryMatch.kind */
    default: {
      throw new Error(
        `resolveRepositoryFor: unexpected match kind ${(match satisfies never as CanonicalizedRepositoryMatch).kind}`,
      );
    }
  }
}

interface ParseRepositoryArguments {
  description: string | undefined;
  config: ResolvedConfig;
  repositoryRegex: RegExp;
  task: string;
}

export function parseRepository(arguments_: ParseRepositoryArguments): string {
  const { description, config, repositoryRegex, task } = arguments_;
  const match = canonicalizeRepositoryMatch(description, config, repositoryRegex);
  switch (match.kind) {
    case "missing":
    case "ambiguous": {
      throw new RepositoryResolutionError({
        task,
        repositories: config.workspace.knownRepositories,
      });
    }
    case "canonical": {
      return match.repository;
    }
    case "unknown": {
      // No match in knownRepositories — return the asserted name as-is. The
      // dispatcher's dispatchableRepository helper WARN-logs and skips at
      // the host layer, uniformly across all sources.
      return match.repository;
    }
    /* v8 ignore next 5 @preserve -- exhaustive over CanonicalizedRepositoryMatch.kind */
    default: {
      throw new Error(
        `parseRepository: unexpected match kind ${(match satisfies never as CanonicalizedRepositoryMatch).kind}`,
      );
    }
  }
}

/**
 * Returns the resolved agent metadata for a task, or `undefined` when the
 * task has no `agent-*` label — those tasks are not groundcrew's concern
 * and downstream code skips them. An explicit `agent-<unknown>` label still
 * falls back to `agents.default` because the user opted in by labeling.
 *
 * `notEnabledFallback` is set when the label matched a built-in agent the
 * user has not enabled (e.g. `agent-codex` when only `claude: {}` is listed).
 * Callers warn on this so the user can spot the config/labeling mismatch; we
 * still fall back rather than skip because skipping would block the task
 * indefinitely. Unknown labels stay silent — those are likelier to be typos.
 */
interface ParsedAgentLabels {
  agent: string;
  notEnabledFallback?: string;
}

function parseAgentLabels(
  labels: { name: string }[],
  config: ResolvedConfig,
): ParsedAgentLabels | undefined {
  const agentLabels = labels.filter((label) => label.name.startsWith(AGENT_LABEL_PREFIX));
  if (agentLabels.length === 0) {
    return undefined;
  }
  let notEnabledFallback: string | undefined;
  for (const label of agentLabels) {
    const name = label.name.slice(AGENT_LABEL_PREFIX.length);
    if (name === AGENT_ANY) {
      return { agent: AGENT_ANY };
    }
    // Own-property check, not `in`: a label like `agent-toString` or
    // `agent-__proto__` would otherwise resolve through the prototype chain
    // instead of falling back to `agents.default`.
    if (Object.hasOwn(config.agents.definitions, name)) {
      return { agent: name };
    }
    if (notEnabledFallback === undefined && isBuiltInAgentNotEnabled(config, name)) {
      notEnabledFallback = name;
    }
  }
  const fallback: ParsedAgentLabels = { agent: config.agents.default };
  if (notEnabledFallback !== undefined) {
    fallback.notEnabledFallback = notEnabledFallback;
  }
  return fallback;
}

export function resolveAgentFor(arguments_: {
  labels: { name: string }[];
  config: ResolvedConfig;
}): AgentResolution {
  const { labels, config } = arguments_;
  const parsed = parseAgentLabels(labels, config);
  if (parsed === undefined) {
    return { kind: "no-label" };
  }
  if (parsed.agent === AGENT_ANY) {
    return { kind: "agent-any" };
  }
  if (parsed.notEnabledFallback !== undefined) {
    return {
      kind: "not-enabled-fallback",
      requestedAgent: parsed.notEnabledFallback,
      fallbackAgent: parsed.agent,
    };
  }
  return { kind: "matched", agent: parsed.agent };
}
