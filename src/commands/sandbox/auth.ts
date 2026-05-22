import { runCommandAsync } from "../../lib/commandRunner.ts";
import type { AuthRecipe, ResolvedConfig } from "../../lib/config.ts";
import { writeOutput } from "../../lib/util.ts";
import { ensureOne } from "./lifecycle.ts";
import { resolveModel } from "./model.ts";

/**
 * Built-in recipes for the bundled agents. Users register additional
 * tools (github, npm, gcloud, …) by adding entries under
 * `sandbox.authRecipes` in `crew.config.ts`; a user recipe under the
 * same key overrides the built-in one.
 */
const BUILTIN_AUTH_RECIPES: Record<string, AuthRecipe> = {
  claude: {
    displayName: "Claude",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    authenticatedPattern: /"loggedIn"\s*:\s*true/,
  },
  codex: {
    displayName: "Codex",
    // `--device-auth` keeps the OAuth flow headless: codex prints a URL
    // and a code instead of trying to open a browser inside the sandbox.
    loginArgs: ["login", "--device-auth"],
    statusArgs: ["login", "status"],
    authenticatedPattern: /Logged in/i,
  },
  cursor: {
    displayName: "Cursor",
    binary: "cursor-agent",
    loginArgs: ["login"],
    statusArgs: ["status"],
    authenticatedPattern: /Logged in/i,
  },
};

function resolveRecipe(config: ResolvedConfig, toolKey: string): AuthRecipe | undefined {
  return config.sandbox.authRecipes[toolKey] ?? BUILTIN_AUTH_RECIPES[toolKey];
}

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

async function runAuthWithRecipe(input: {
  sandboxName: string;
  toolKey: string;
  recipe: AuthRecipe;
  force: boolean;
  retryHint: string;
}): Promise<void> {
  const { sandboxName, toolKey, recipe, force, retryHint } = input;
  writeOutput(`${sandboxName}: checking '${recipe.displayName}' authentication status...`);
  const alreadyAuthenticated = await probeAuthStatus(sandboxName, toolKey, recipe);
  if (alreadyAuthenticated && !force) {
    writeOutput(
      `${sandboxName}: '${recipe.displayName}' already authenticated — skipping login. Re-run with --force to log in again.`,
    );
    return;
  }
  if (alreadyAuthenticated) {
    writeOutput(
      `${sandboxName}: '${recipe.displayName}' already authenticated, re-authenticating (--force).`,
    );
  }

  const binary = binaryFor(toolKey, recipe);
  writeOutput("");
  writeOutput(`${sandboxName}: launching '${recipe.displayName}' login...`);
  writeOutput("Complete the login flow in the prompts/browser, then return here.");
  await runCommandAsync("sbx", ["exec", "-it", sandboxName, binary, ...recipe.loginArgs], {
    stdio: "inherit",
  });

  writeOutput("");
  writeOutput(`${sandboxName}: checking '${recipe.displayName}' authentication status...`);
  const authenticated = await probeAuthStatus(sandboxName, toolKey, recipe);
  if (authenticated) {
    writeOutput(`${sandboxName}: '${recipe.displayName}' authenticated.`);
    return;
  }
  writeOutput(
    `${sandboxName}: could not confirm '${recipe.displayName}' authentication — ${retryHint}`,
  );
}

async function runAuthManual(sandboxName: string, toolKey: string): Promise<void> {
  writeOutput(
    `No login recipe for '${toolKey}'. Authenticate manually inside the sandbox, then exit (Ctrl+D).`,
  );
  writeOutput(`${sandboxName}: launching '${toolKey}'...`);
  await runCommandAsync("sbx", ["exec", "-it", sandboxName, toolKey], { stdio: "inherit" });
  writeOutput("");
  writeOutput(`${sandboxName}: exited — verify '${toolKey}' authentication manually.`);
}

interface AuthOptions {
  modelName: string;
  toolName: string | undefined;
  force: boolean;
}

function parseAuthArgs(argv: string[]): AuthOptions {
  const positionals: string[] = [];
  let force = false;
  for (const argument of argv) {
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`crew sandbox auth: unknown option '${argument}'`);
    }
    positionals.push(argument);
  }
  const [modelName, toolName, ...rest] = positionals;
  if (modelName === undefined || rest.length > 0) {
    throw new Error("Usage: crew sandbox auth [--force] <model> [<tool>]");
  }
  return { modelName, toolName, force };
}

export async function runAuth(config: ResolvedConfig, argv: string[]): Promise<void> {
  const { modelName, toolName, force } = parseAuthArgs(argv);
  const model = resolveModel(config, modelName);
  writeOutput(`${model.sandboxName}: ensuring sandbox is up...`);
  await ensureOne(config, model);

  const toolKey = toolName ?? model.sandbox.agent;
  const recipe = resolveRecipe(config, toolKey);
  writeOutput("");
  if (recipe === undefined) {
    await runAuthManual(model.sandboxName, toolKey);
    return;
  }
  const retryHint =
    toolName === undefined
      ? `re-run 'crew sandbox auth ${modelName}' to retry.`
      : `re-run 'crew sandbox auth ${modelName} ${toolName}' to retry.`;
  await runAuthWithRecipe({
    sandboxName: model.sandboxName,
    toolKey,
    recipe,
    force,
    retryHint,
  });
}
