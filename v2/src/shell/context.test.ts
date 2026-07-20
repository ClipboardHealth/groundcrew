import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ContextEnvironment, loadContext } from "./context.js";
import { ConfigError } from "./errors.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-context-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a config file under a temp dir and builds a context pointed at it. */
function contextFor(
  configBody: Record<string, unknown>,
  files: Record<string, string> = {},
  envOverrides: ContextEnvironment = {},
) {
  const configPath = path.join(root, "crew.config.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ workspace: { baseDirectory: path.join(root, "repos") }, ...configBody }),
  );
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents);
  }

  const environment: ContextEnvironment = {
    GROUNDCREW_CONFIG: configPath,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...envOverrides,
  };
  return loadContext({ environment, cwd: root, verbose: false, consoleLevel: "silent" });
}

describe("Context.promptTemplate", () => {
  it("returns undefined when no prompts are configured", () => {
    expect(contextFor({}).promptTemplate()).toBeUndefined();
  });

  it("returns the inline prompts.initial", () => {
    expect(contextFor({ prompts: { initial: "do {{id}}" } }).promptTemplate()).toBe("do {{id}}");
  });

  it("reads prompts.promptFile relative to the config file", () => {
    const context = contextFor(
      { prompts: { promptFile: "prompt.txt" } },
      { "prompt.txt": "from the file {{title}}" },
    );
    expect(context.promptTemplate()).toBe("from the file {{title}}");
  });

  it("throws when both initial and promptFile are set", () => {
    const context = contextFor({ prompts: { initial: "x", promptFile: "prompt.txt" } });
    expect(() => context.promptTemplate()).toThrow(ConfigError);
  });

  it("throws a clear error when promptFile cannot be read", () => {
    const context = contextFor({ prompts: { promptFile: "missing.txt" } });
    expect(() => context.promptTemplate()).toThrow(/could not be read/);
  });
});

describe("Context.prepareHookSandbox", () => {
  it("returns a hook-wrapper when the sandbox is on (default)", () => {
    expect(contextFor({}).prepareHookSandbox()).toBeTypeOf("function");
  });

  it("returns undefined under the GROUNDCREW_SANDBOX=off kill-switch (hook runs unwrapped)", () => {
    const context = contextFor({}, {}, { GROUNDCREW_SANDBOX: "off" });
    expect(context.prepareHookSandbox()).toBeUndefined();
  });
});
