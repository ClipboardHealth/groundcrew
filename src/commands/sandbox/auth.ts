import { runCommandAsync } from "../../lib/commandRunner.ts";
import type { AuthRecipe, ResolvedConfig } from "../../lib/config.ts";
import { writeOutput } from "../../lib/util.ts";
import { ensureOne } from "./lifecycle.ts";
import { requireOnePositional, resolveModel, type SandboxModel } from "./model.ts";
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
    authenticatedPattern: /Logged in/i,
    kind: "agent",
  },
  cursor: {
    displayName: "Cursor",
    binary: "cursor-agent",
    loginArgs: ["login"],
    statusArgs: ["status"],
    authenticatedPattern: /Logged in/i,
    kind: "agent",
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

async function probeAuthStatus(
  sandboxName: string,
  toolKey: string,
  recipe: AuthRecipe,
): Promise<boolean> {
  // Some CLIs print status to stderr instead of stdout (codex does
  // this). Fold stderr into stdout via the in-sandbox shell so the
  // pattern match sees the message regardless of which stream it
  // landed on. The argv is composed from hard-coded/config recipe
  // values, so there's no untrusted runtime input flowing into the
  // shell.
  const innerCommand = `${[binaryFor(toolKey, recipe), ...recipe.statusArgs].join(" ")} 2>&1`;
  try {
    const output = await runCommandAsync("sbx", ["exec", sandboxName, "sh", "-c", innerCommand]);
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
}): Promise<void> {
  const { sandboxName, toolKey, recipe, modelName } = input;
  const binary = binaryFor(toolKey, recipe);
  writeOutput(`${sandboxName}: launching '${recipe.displayName}' login...`);
  writeOutput("Complete the login flow in the prompts/browser, then return here.");
  await runCommandAsync("sbx", ["exec", "-it", sandboxName, binary, ...recipe.loginArgs], {
    stdio: "inherit",
  });

  writeOutput("");
  writeOutput(`${sandboxName}: verifying '${recipe.displayName}' authentication...`);
  const authenticated = await probeAuthStatus(sandboxName, toolKey, recipe);
  if (authenticated) {
    writeOutput(`${sandboxName}: '${recipe.displayName}' authenticated.`);
    return;
  }
  writeOutput(
    `${sandboxName}: could not confirm '${recipe.displayName}' authentication — re-run 'crew sandbox auth ${modelName}' to retry.`,
  );
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

export async function runAuth(config: ResolvedConfig, argv: string[]): Promise<void> {
  const modelName = requireOnePositional(argv, "Usage: crew sandbox auth <model>");
  const model = resolveModel(config, modelName);
  writeOutput(`${model.sandboxName}: ensuring sandbox is up...`);
  await ensureOne(config, model);
  writeOutput("");
  await runAuthInteractive(config, model, modelName);
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
    });
  }
}
