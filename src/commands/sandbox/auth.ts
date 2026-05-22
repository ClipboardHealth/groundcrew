import { runCommandAsync } from "../../lib/commandRunner.ts";
import type { ResolvedConfig } from "../../lib/config.ts";
import { writeOutput } from "../../lib/util.ts";
import { ensureOne } from "./lifecycle.ts";
import { requireOnePositional, resolveModel } from "./model.ts";

/**
 * Per-agent recipe for driving login and verifying status non-interactively.
 *
 * `binary` defaults to the sbx agent name; override when the in-sandbox
 * binary differs (cursor's sbx agent is `cursor`, binary is `cursor-agent`).
 * `authenticatedPattern` is matched against `sbx exec` stdout from
 * `statusArgs` — exit code alone isn't reliable because some agents
 * print "not logged in" while still returning 0.
 */
interface AgentAuthRecipe {
  displayName: string;
  binary?: string;
  loginArgs: readonly string[];
  statusArgs: readonly string[];
  authenticatedPattern: RegExp;
}

const AGENT_AUTH_RECIPES: Record<string, AgentAuthRecipe> = {
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

function binaryFor(agent: string, recipe: AgentAuthRecipe): string {
  return recipe.binary ?? agent;
}

async function probeAuthStatus(
  sandboxName: string,
  agent: string,
  recipe: AgentAuthRecipe,
): Promise<boolean> {
  // Some agent CLIs print status to stderr instead of stdout (codex
  // does this). Fold stderr into stdout via the in-sandbox shell so the
  // pattern match sees the message regardless of which stream it
  // landed on. The argv is composed from hard-coded recipe values, so
  // there's no untrusted input flowing into the shell.
  const innerCommand = `${[binaryFor(agent, recipe), ...recipe.statusArgs].join(" ")} 2>&1`;
  try {
    const output = await runCommandAsync("sbx", ["exec", sandboxName, "sh", "-c", innerCommand]);
    return recipe.authenticatedPattern.test(output);
  } catch {
    return false;
  }
}

async function runAuthWithRecipe(
  sandboxName: string,
  agent: string,
  modelName: string,
  recipe: AgentAuthRecipe,
): Promise<void> {
  const binary = binaryFor(agent, recipe);
  writeOutput(`${sandboxName}: launching '${recipe.displayName}' login...`);
  writeOutput("Complete the login flow in the prompts/browser, then return here.");
  await runCommandAsync("sbx", ["exec", "-it", sandboxName, binary, ...recipe.loginArgs], {
    stdio: "inherit",
  });

  writeOutput("");
  writeOutput(`${sandboxName}: checking authentication status...`);
  const authenticated = await probeAuthStatus(sandboxName, agent, recipe);
  if (authenticated) {
    writeOutput(`${sandboxName}: authenticated.`);
    return;
  }
  writeOutput(
    `${sandboxName}: could not confirm authentication — re-run 'crew sandbox auth ${modelName}' to retry.`,
  );
}

async function runAuthManual(sandboxName: string, agent: string): Promise<void> {
  writeOutput(
    `Unknown agent '${agent}' — no automated login recipe. Authenticate manually inside the sandbox, then exit (Ctrl+D).`,
  );
  writeOutput(`${sandboxName}: launching '${agent}'...`);
  await runCommandAsync("sbx", ["exec", "-it", sandboxName, agent], { stdio: "inherit" });
  writeOutput("");
  writeOutput(`${sandboxName}: exited — verify '${agent}' authentication manually.`);
}

export async function runAuth(config: ResolvedConfig, argv: string[]): Promise<void> {
  const modelName = requireOnePositional(argv, "Usage: crew sandbox auth <model>");
  const model = resolveModel(config, modelName);
  writeOutput(`${model.sandboxName}: ensuring sandbox is up...`);
  await ensureOne(config, model);

  const recipe = AGENT_AUTH_RECIPES[model.sandbox.agent];
  writeOutput("");
  if (recipe === undefined) {
    await runAuthManual(model.sandboxName, model.sandbox.agent);
    return;
  }
  await runAuthWithRecipe(model.sandboxName, model.sandbox.agent, modelName, recipe);
}
