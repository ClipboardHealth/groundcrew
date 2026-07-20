import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, V1ConfigError } from "../errors.js";
import { findV1Config, loadConfig, locateConfig, parseConfigFile } from "./load.js";

const roots: string[] = [];

function scratch(): { home: string; configHome: string; cwd: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shell-load-"));
  roots.push(home);
  const configHome = path.join(home, ".config");
  const cwd = path.join(home, "cwd");
  fs.mkdirSync(path.join(configHome, "groundcrew"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { home, configHome, cwd };
}

function env(home: string, configHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, XDG_CONFIG_HOME: configHome, ...extra };
}

const MINIMAL = '{ "workspace": { "baseDirectory": "~/dev" } }';

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("locateConfig", () => {
  it("prefers $GROUNDCREW_CONFIG over local and global", () => {
    const { home, configHome, cwd } = scratch();
    const explicit = path.join(home, "explicit.jsonc");
    fs.writeFileSync(explicit, MINIMAL);
    fs.writeFileSync(path.join(cwd, "crew.config.jsonc"), MINIMAL);
    const located = locateConfig({ environment: env(home, configHome, { GROUNDCREW_CONFIG: explicit }), cwd });
    expect(located?.path).toBe(explicit);
  });

  it("throws when $GROUNDCREW_CONFIG points at a missing file", () => {
    const { home, configHome, cwd } = scratch();
    expect(() =>
      locateConfig({ environment: env(home, configHome, { GROUNDCREW_CONFIG: "/nope.jsonc" }), cwd }),
    ).toThrow(ConfigError);
  });

  it("prefers project-local ./crew.config.jsonc over global", () => {
    const { home, configHome, cwd } = scratch();
    fs.writeFileSync(path.join(cwd, "crew.config.jsonc"), MINIMAL);
    fs.writeFileSync(path.join(configHome, "groundcrew", "crew.config.jsonc"), MINIMAL);
    expect(locateConfig({ environment: env(home, configHome), cwd })?.path).toBe(
      path.join(cwd, "crew.config.jsonc"),
    );
  });

  it("falls back to the global config", () => {
    const { home, configHome, cwd } = scratch();
    const global = path.join(configHome, "groundcrew", "crew.config.jsonc");
    fs.writeFileSync(global, MINIMAL);
    expect(locateConfig({ environment: env(home, configHome), cwd })?.path).toBe(global);
  });

  it("returns undefined when nothing exists", () => {
    const { home, configHome, cwd } = scratch();
    expect(locateConfig({ environment: env(home, configHome), cwd })).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("parses JSONC with comments and trailing commas", () => {
    const { home, configHome, cwd } = scratch();
    fs.writeFileSync(
      path.join(cwd, "crew.config.jsonc"),
      '{ /* c */ "workspace": { "baseDirectory": "~/dev", }, }',
    );
    const loaded = loadConfig({ environment: env(home, configHome), cwd });
    expect(loaded.config.workspace.baseDirectory).toBe("~/dev");
  });

  it("fails loudly with a migration pointer when only a v1 config exists", () => {
    const { home, configHome, cwd } = scratch();
    fs.writeFileSync(path.join(cwd, "crew.config.ts"), "export default {}");
    let error: unknown;
    try {
      loadConfig({ environment: env(home, configHome), cwd });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(V1ConfigError);
    expect((error as Error).message).toMatch(/init/);
    expect((error as Error).message).toMatch(/v1/);
  });

  it("tells the user to run crew init when no config exists", () => {
    const { home, configHome, cwd } = scratch();
    expect(() => loadConfig({ environment: env(home, configHome), cwd })).toThrow(/crew init/);
  });

  it("rejects a structurally invalid config naming the file", () => {
    const { cwd } = scratch();
    const p = path.join(cwd, "crew.config.jsonc");
    fs.writeFileSync(p, '{ "workspace": {} }');
    expect(() => parseConfigFile(p)).toThrow(ConfigError);
  });

  it("finds a v1 config in cwd or the global dir", () => {
    const { home, configHome, cwd } = scratch();
    fs.writeFileSync(path.join(configHome, "groundcrew", "crew.config.ts"), "x");
    expect(findV1Config({ environment: env(home, configHome), cwd })).toContain("crew.config.ts");
  });
});
