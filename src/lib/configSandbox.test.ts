import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import type { Config, ResolvedConfig } from "./config.ts";

interface ConfigModule {
  loadConfig: () => Promise<Readonly<ResolvedConfig>>;
}

async function loadFreshConfig(): Promise<ConfigModule> {
  vi.resetModules();
  return await import("./config.ts");
}

const VALID_LINEAR: Config["linear"] = {
  projects: [{ projectSlug: "ai-strategy-5152195762f3" }],
};

const VALID_WORKSPACE = (projectDir: string) => ({
  projectDir,
  knownRepositories: ["repo-a"],
});

function writeConfigFile(dir: string, body: string): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(path, body);
  return path;
}

describe("loadConfig sandbox.authRecipes", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "groundcrew-config-sandbox-"));
    for (const key of ENV_KEYS) {
      deleteEnvironmentVariable(key);
    }
    setEnvironmentVariable("XDG_CONFIG_HOME", join(temporary, "xdg-config"));
    setEnvironmentVariable("XDG_STATE_HOME", join(temporary, "xdg-state"));
    vi.spyOn(process, "cwd").mockReturnValue(temporary);
  });

  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const original = originalEnvironment[key];
      if (original === undefined) {
        deleteEnvironmentVariable(key);
      } else {
        setEnvironmentVariable(key, original);
      }
    }
    vi.restoreAllMocks();
  });

  function configWith(sandboxBlock: string): string {
    return [
      "export default {",
      `  linear: ${JSON.stringify(VALID_LINEAR)},`,
      `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
      `  sandbox: ${sandboxBlock},`,
      "};",
    ].join("\n");
  }

  function writeAndPoint(body: string): void {
    const path = writeConfigFile(temporary, body);
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
  }

  it("rejects a non-object sandbox block", async () => {
    writeAndPoint(configWith("'oops'"));
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox must be an object/);
  });

  it("rejects a non-object sandbox.authRecipes block", async () => {
    writeAndPoint(configWith("{ authRecipes: 'nope' }"));
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes must be an object/);
  });

  it("rejects an authRecipe entry that is not an object", async () => {
    writeAndPoint(configWith("{ authRecipes: { gh: 'oops' } }"));
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes\.gh must be an object/);
  });

  it("rejects an authRecipe missing loginArgs", async () => {
    writeAndPoint(configWith("{ authRecipes: { gh: { displayName: 'gh' } } }"));
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes\.gh\.loginArgs/);
  });

  it("rejects an authRecipe missing statusArgs", async () => {
    writeAndPoint(
      configWith("{ authRecipes: { gh: { displayName: 'gh', loginArgs: ['auth','login'] } } }"),
    );
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes\.gh\.statusArgs is required/);
  });

  it("rejects an authRecipe with a non-RegExp authenticatedPattern", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { gh: { displayName: 'gh', loginArgs: ['auth','login'], statusArgs: ['auth','status'], authenticatedPattern: 'logged-in' } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /sandbox\.authRecipes\.gh\.authenticatedPattern must be a RegExp/,
    );
  });

  it("rejects an authRecipe with an invalid kind", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { gh: { displayName: 'gh', loginArgs: ['auth'], statusArgs: ['status'], authenticatedPattern: /ok/, kind: 'bogus' } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /sandbox\.authRecipes\.gh\.kind must be "agent" or "tool"/,
    );
  });

  it("rejects an authRecipe with a non-object env block", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { gh: { displayName: 'gh', loginArgs: ['auth'], statusArgs: ['status'], authenticatedPattern: /ok/, env: 'NO' } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes\.gh\.env must be an object/);
  });

  it("rejects an authRecipe whose env value is not a string", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { gh: { displayName: 'gh', loginArgs: ['auth'], statusArgs: ['status'], authenticatedPattern: /ok/, env: { FLAG: 1 } } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /sandbox\.authRecipes\.gh\.env\.FLAG must be a string/,
    );
  });

  it("accepts a minimal authRecipe with no optional fields", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { gh: { displayName: 'gh', loginArgs: ['x'], statusArgs: ['y'], authenticatedPattern: /ok/ } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    const recipe = actual.sandbox.authRecipes["gh"];
    expect(recipe).toMatchObject({ displayName: "gh" });
    expect(recipe?.binary).toBeUndefined();
    expect(recipe?.kind).toBeUndefined();
    expect(recipe?.env).toBeUndefined();
  });

  it("accepts an authRecipe with kind: 'agent'", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { claude: { displayName: 'Claude', loginArgs: ['auth'], statusArgs: ['status'], authenticatedPattern: /ok/, kind: 'agent' } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sandbox.authRecipes["claude"]?.kind).toBe("agent");
  });

  it("threads a fully-specified authRecipe through to the resolved config", async () => {
    writeAndPoint(
      configWith(
        "{ authRecipes: { gh: { displayName: 'GitHub CLI', binary: 'gh', loginArgs: ['auth','login'], statusArgs: ['auth','status'], authenticatedPattern: /Logged in/, kind: 'tool', env: { NO_OPEN_BROWSER: '1' } } } }",
      ),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sandbox.authRecipes["gh"]).toMatchObject({
      displayName: "GitHub CLI",
      binary: "gh",
      kind: "tool",
      env: { NO_OPEN_BROWSER: "1" },
    });
  });
});
