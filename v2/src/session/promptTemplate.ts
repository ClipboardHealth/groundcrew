/**
 * Per-task prompt templating (contracts §5 `prompts`, §9). Dispatch renders a
 * template once per task so the launched agent actually receives its task
 * context — the P0 regression this module fixes was that only a static, global
 * string reached the agent (v1 baked the full task prose into the prompt).
 *
 * A template supports four placeholders, substituted from the task: `{{id}}`
 * (canonical `<source>:<localId>`), `{{title}}`, `{{description}}`, and
 * `{{repos}}` (comma-separated designated repos). A placeholder with no value
 * renders empty. When config names no `prompts.initial`/`prompts.promptFile`,
 * dispatch renders {@link DEFAULT_PROMPT_TEMPLATE} — modeled on v1's default
 * prompt, adapted to v2 vocabulary and closing with {@link CREW_DONE_INSTRUCTION}.
 */

import { CREW_DONE_INSTRUCTION } from "./profiles.js";

/** The task fields interpolated into a prompt template. */
export interface PromptTemplateVariables {
  /** Canonical task id (`<source>:<localId>`). */
  id: string;
  title?: string;
  description?: string;
  /** Designated repos; rendered as a comma-separated list. */
  repos?: readonly string[];
}

/**
 * The default per-task prompt: task header (id + title), the description block
 * verbatim, the designated repos, the operating mode and workflow, then the
 * `crew done` closing instruction. Used when config names no prompt template.
 */
export const DEFAULT_PROMPT_TEMPLATE = [
  "You are a groundcrew agent working on task {{id}}: {{title}}.",
  "",
  "## Task description",
  "",
  "<task_description>",
  "{{description}}",
  "</task_description>",
  "",
  "## Designated repositories",
  "",
  "{{repos}}",
  "",
  "## Operating mode",
  "",
  "There is no human watching this session. Do not stop to ask clarifying questions. When the task is ambiguous or incomplete, choose the simplest reasonable interpretation consistent with the task and the codebase, then document that choice in your output.",
  "",
  "## Workflow",
  "",
  "1. Inspect the repository instructions and existing patterns before making changes.",
  "2. Implement the smallest sensible change that completes the task.",
  "3. Run the repository's documented verification command. If none exists, run the smallest relevant test suite you can find and fix failures you introduced before continuing.",
  "4. Follow the task description for output. If it names none, open a PR whose description closes {{id}}. If you cannot open one, leave the branch ready and record the blocker in your output.",
  "",
  CREW_DONE_INSTRUCTION,
].join("\n");

/**
 * Render a prompt template against a task's fields. Each of the four known
 * placeholders is replaced; a missing value renders empty. Unknown `{{…}}`
 * tokens in a user template are left untouched.
 */
export function renderPromptTemplate(input: {
  template: string;
  variables: PromptTemplateVariables;
}): string {
  const { template, variables } = input;
  return template
    .replaceAll("{{id}}", variables.id)
    .replaceAll("{{title}}", variables.title ?? "")
    .replaceAll("{{description}}", variables.description ?? "")
    .replaceAll("{{repos}}", (variables.repos ?? []).join(", "));
}
