export interface CloudPromptVariables {
  task: string;
  title: string;
  description: string;
  branch: string;
}

export const CLOUD_PROMPT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "{{task}}",
  "{{title}}",
  "{{description}}",
  "{{branch}}",
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
  "2. Prepare the toolchain and dependencies before any other work. If the repository pins tool versions (`mise.toml`, `.nvmrc`, `.tool-versions`) and `mise` is available, run `mise install`. Check that `node -v` and `npm -v` match the pins. Then install dependencies the way the repository documents, for example `npm ci` when there is a `package-lock.json`. If installation fails, report the exact error in the PR description, or in the session if no PR can be opened, instead of working around it.",
  "3. Implement the smallest sensible change that completes the task.",
  "4. Run the repo's documented verification command. If no documented command exists, run the smallest relevant test suite you can find and fix failures you introduced before continuing.",
  "5. Before making changes, make sure you are on `{{branch}}`, for example `git fetch origin {{branch}} && git checkout {{branch}}`. Commit only to `{{branch}}` and push only to `{{branch}}`. Never create or push any other branch. If pushing to `{{branch}}` is rejected, report exactly what the error was.",
  "6. Open the PR with head `{{branch}}` and base the repository's default branch, using whatever GitHub tooling this session has. `gh pr create` does not work here; use `gh api repos/{owner}/{repo}/pulls` or the session's GitHub tools. Give it a title and a body that contains `Closes {{task}}`. If you cannot open the PR, leave `{{branch}}` pushed and record the blocker.",
  "7. After the PR is open, watch it. Fix CI failures and review comments by pushing new commits to `{{branch}}`. Do not open a second PR.",
].join("\n");

export function renderCloudPrompt(template: string, variables: CloudPromptVariables): string {
  return template
    .replaceAll("{{task}}", () => variables.task)
    .replaceAll("{{title}}", () => variables.title)
    .replaceAll("{{description}}", () => variables.description)
    .replaceAll("{{branch}}", () => variables.branch);
}
