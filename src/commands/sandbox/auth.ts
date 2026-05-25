import { runCommandAsync } from "../../lib/commandRunner.ts";
import type { AuthRecipe, ResolvedConfig } from "../../lib/config.ts";
import { writeOutput } from "../../lib/util.ts";
import { ensureOne } from "./lifecycle.ts";
import { resolveModel, type SandboxModel, sandboxModels } from "./model.ts";
import { pickTools, type ToolChoice } from "./picker.ts";

/**
 * Built-in recipes shipped with crew. Users register additional tools
 * by adding entries under `sandbox.authRecipes` in `crew.config.ts`;
 * a user recipe under the same key overrides the built-in.
 *
 * `kind: "agent"` recipes only appear in the picker when the current
 * sandbox's agent matches the recipe key. `kind: "tool"` (the default
 * for user recipes) is cross-cutting and always appears.
 */
const BUILTIN_AUTH_RECIPES: Record<string, AuthRecipe> = {
  claude: {
    displayName: "Claude",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    authenticatedPattern: /"loggedIn"\s*:\s*true/,
    kind: "agent",
  },
  codex: {
    displayName: "Codex",
    // `--device-auth` keeps the OAuth flow headless: codex prints a URL
    // and a code instead of trying to open a browser inside the sandbox.
    loginArgs: ["login", "--device-auth"],
    statusArgs: ["login", "status"],
    // Match "Logged in using …" but not a hypothetical "Not logged in".
    authenticatedPattern: /(^|\W)Logged in using\b/i,
    kind: "agent",
  },
  cursor: {
    displayName: "Cursor",
    binary: "cursor-agent",
    loginArgs: ["login"],
    statusArgs: ["status"],
    // Authenticated output is "✓ Logged in as <email>"; the unauthenticated
    // output is "Not logged in", which a loose /Logged in/i would falsely
    // match.
    authenticatedPattern: /Logged in as\b/i,
    kind: "agent",
    // cursor-agent tries to open a browser by default and silently
    // writes a partial auth file when xdg-open fails; this env var
    // switches it to a device-code flow that works without a browser.
    env: { NO_OPEN_BROWSER: "1" },
  },
  github: {
    displayName: "GitHub CLI",
    binary: "gh",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    authenticatedPattern: /Logged in to github\.com/i,
    kind: "tool",
  },
};

function binaryFor(toolKey: string, recipe: AuthRecipe): string {
  return recipe.binary ?? toolKey;
}

function envFlags(recipe: AuthRecipe): string[] {
  const entries = Object.entries(recipe.env ?? {});
  return entries.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

// User-supplied recipes can carry arbitrary tokens; wrap each in single
// quotes so spaces and shell metacharacters can't change how the in-sandbox
// shell tokenizes the status command.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function probeAuthStatus(
  sandboxName: string,
  toolKey: string,
  recipe: AuthRecipe,
): Promise<boolean> {
  // Some CLIs print status to stderr instead of stdout (codex does
  // this). Fold stderr into stdout via the in-sandbox shell so the
  // pattern match sees the message regardless of which stream it
  // landed on.
  const innerCommand = `${[binaryFor(toolKey, recipe), ...recipe.statusArgs]
    .map(shellQuote)
    .join(" ")} 2>&1`;
  try {
    const output = await runCommandAsync("sbx", [
      "exec",
      ...envFlags(recipe),
      sandboxName,
      "sh",
      "-c",
      innerCommand,
    ]);
    // Reset lastIndex so a /g or /y user recipe doesn't carry state
    // across probes and return a false negative.
    recipe.authenticatedPattern.lastIndex = 0;
    return recipe.authenticatedPattern.test(output);
  } catch {
    return false;
  }
}

async function loginAndVerify(input: {
  sandboxName: string;
  toolKey: string;
  recipe: AuthRecipe;
  modelName: string;
  gitDefaults: boolean;
}): Promise<void> {
  const { sandboxName, toolKey, recipe, modelName, gitDefaults } = input;
  const binary = binaryFor(toolKey, recipe);
  writeOutput(`${sandboxName}: launching '${recipe.displayName}' login...`);
  writeOutput("Complete the login flow in the prompts/browser, then return here.");
  await runCommandAsync(
    "sbx",
    ["exec", "-it", ...envFlags(recipe), sandboxName, binary, ...recipe.loginArgs],
    { stdio: "inherit" },
  );

  writeOutput("");
  writeOutput(`${sandboxName}: verifying '${recipe.displayName}' authentication...`);
  const authenticated = await probeAuthStatus(sandboxName, toolKey, recipe);
  if (authenticated) {
    writeOutput(`${sandboxName}: '${recipe.displayName}' authenticated.`);
    if (gitDefaults && toolKey === "github" && binary === "gh") {
      await runGhSetupGit(sandboxName);
    }
    return;
  }
  writeOutput(
    `${sandboxName}: could not confirm '${recipe.displayName}' authentication — re-run 'crew sandbox auth ${modelName}' to retry.`,
  );
}

/**
 * Register `gh` as git's credential helper inside the sandbox so HTTPS
 * pushes succeed without prompting. Best-effort — a failure here doesn't
 * undo the login itself, so we warn and move on.
 */
async function runGhSetupGit(sandboxName: string): Promise<void> {
  writeOutput(`${sandboxName}: wiring 'gh' as git credential helper...`);
  try {
    await runCommandAsync("sbx", ["exec", sandboxName, "gh", "auth", "setup-git"]);
    writeOutput(`${sandboxName}: 'gh auth setup-git' done.`);
  } catch (error) {
    writeOutput(`${sandboxName}: warning — 'gh auth setup-git' failed: ${String(error)}`);
  }
}

interface RecipeEntry {
  key: string;
  recipe: AuthRecipe;
}

function availableRecipes(config: ResolvedConfig): RecipeEntry[] {
  const merged: Record<string, AuthRecipe> = {
    ...BUILTIN_AUTH_RECIPES,
    ...config.sandbox.authRecipes,
  };
  return Object.entries(merged)
    .map(([key, recipe]) => ({ key, recipe }))
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

function shouldShowInPicker(entry: RecipeEntry, currentAgent: string): boolean {
  // Tools (the default) appear in every sandbox. Agent recipes only
  // appear when they match the current sandbox's agent, so opening
  // 'crew sandbox auth codex' doesn't list Claude or Cursor.
  const kind = entry.recipe.kind ?? "tool";
  return kind === "tool" || entry.key === currentAgent;
}

interface AuthTarget {
  modelName: string;
  model: SandboxModel;
}

interface AuthOptions {
  models: AuthTarget[];
}

const AUTH_USAGE = "Usage: crew sandbox auth <model> | --all";

function parseAuthArgs(config: ResolvedConfig, argv: string[]): AuthOptions {
  const positionals: string[] = [];
  let all = false;
  for (const argument of argv) {
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`crew sandbox auth: unknown option '${argument}'`);
    }
    positionals.push(argument);
  }
  if (all && positionals.length > 0) {
    throw new Error("crew sandbox auth: --all cannot be combined with a model name");
  }
  if (all) {
    const models = sandboxModels(config);
    if (models.length === 0) {
      throw new Error("crew sandbox auth --all: no sandbox-bearing models configured");
    }
    return { models: models.map((model) => ({ modelName: model.modelName, model })) };
  }
  const [modelName, ...extras] = positionals;
  if (modelName === undefined || extras.length > 0) {
    throw new Error(AUTH_USAGE);
  }
  return { models: [{ modelName, model: resolveModel(config, modelName) }] };
}

export async function runAuth(config: ResolvedConfig, argv: string[]): Promise<void> {
  const { models } = parseAuthArgs(config, argv);
  for (const [index, { modelName, model }] of models.entries()) {
    if (models.length > 1) {
      writeOutput("");
      writeOutput(`════ ${modelName} (${index + 1}/${models.length}) ════`);
    }
    writeOutput(`${model.sandboxName}: ensuring sandbox is up...`);
    // oxlint-disable-next-line no-await-in-loop -- each sandbox is interactive; running them sequentially keeps the prompts coherent
    await ensureOne(config, model);
    writeOutput("");
    // oxlint-disable-next-line no-await-in-loop -- intentionally sequential, see above
    await runAuthInteractive(config, model, modelName);
  }
}

async function runAuthInteractive(
  config: ResolvedConfig,
  model: SandboxModel,
  modelName: string,
): Promise<void> {
  const recipes = availableRecipes(config).filter((entry) =>
    shouldShowInPicker(entry, model.sandbox.agent),
  );

  writeOutput(`${model.sandboxName}: probing authentication status for ${recipes.length} tools...`);
  const statuses = await Promise.all(
    recipes.map(async ({ key, recipe }) => ({
      key,
      recipe,
      authenticated: await probeAuthStatus(model.sandboxName, key, recipe),
    })),
  );
  const choices: ToolChoice[] = statuses.map(({ key, recipe, authenticated }) => ({
    key,
    label: `${recipe.displayName} (${key})`,
    authenticated,
  }));

  writeOutput("");
  const selectedKeys = await pickTools(choices);
  if (selectedKeys.length === 0) {
    writeOutput("Nothing selected. Exiting.");
    return;
  }
  const selectedRecipes = new Map(statuses.map((entry) => [entry.key, entry.recipe]));
  for (const key of selectedKeys) {
    const recipe = selectedRecipes.get(key);
    /* v8 ignore next 3 @preserve - defensive; selectedKeys come from the same map */
    if (recipe === undefined) {
      continue;
    }
    writeOutput("");
    writeOutput(`── ${recipe.displayName} ──`);
    // oxlint-disable-next-line no-await-in-loop -- each login is interactive; running them sequentially keeps the prompts coherent
    await loginAndVerify({
      sandboxName: model.sandboxName,
      toolKey: key,
      recipe,
      modelName,
      gitDefaults: config.sandbox.gitDefaults,
    });
  }
}
