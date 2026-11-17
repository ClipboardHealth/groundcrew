export interface CloudPromptVariables {
  task: string;
  title: string;
  description: string;
}

export const CLOUD_PROMPT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "{{task}}",
  "{{title}}",
  "{{description}}",
]);

export const DEFAULT_CLOUD_PROMPT_INITIAL = [
  "You are working on task {{task}} ({{title}}).",
  "",
  "## Task description",
  "",
  "<task_description>",
  "{{description}}",
  "</task_description>",
  "",
  "## Operating mode",
  "",
  "There is no human watching this session. Do not stop to ask clarifying questions. When the task is ambiguous or incomplete, choose the simplest reasonable interpretation consistent with the task and the codebase, then document that choice in the PR description.",
  "",
  "## Workflow",
  "",
  "1. Inspect the repo instructions and existing patterns before edits.",
  "2. Implement the smallest sensible change that completes the task.",
  "3. Run the repo's documented verification command. If no documented command exists, run the smallest relevant test suite you can find and fix failures you introduced before continuing.",
  "4. Commit your changes to the branch you were cloned on. Do not create another branch.",
  "5. Open the PR through the REST API, because `gh pr create` fails in this environment: `gh api repos/{owner}/{repo}/pulls` with the title, the head set to your branch, the base set to the default branch, and a body that contains `Closes {{task}}`. If you cannot open the PR, leave the branch pushed and record the blocker.",
  "6. After the PR is open, watch it. Fix CI failures and review comments by pushing new commits to the same branch. Do not open a second PR.",
].join("\n");

export function renderCloudPrompt(template: string, variables: CloudPromptVariables): string {
  return template
    .replaceAll("{{task}}", () => variables.task)
    .replaceAll("{{title}}", () => variables.title)
    .replaceAll("{{description}}", () => variables.description);
}
