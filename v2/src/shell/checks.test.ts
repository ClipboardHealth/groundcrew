import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkBaseDirectory, checkCredentialsInConfig } from "./checks.js";
import type { Context } from "./context.js";

function contextWithBaseDirectory(baseDirectory: string): Context {
  return { workspaceConfig: () => ({ baseDirectory }) } as unknown as Context;
}

describe("checkCredentialsInConfig", () => {
  it("passes a config with no credential-looking strings", () => {
    const result = checkCredentialsInConfig('{ "workspace": { "baseDirectory": "~/dev" } }');
    expect(result.ok).toBe(true);
  });

  it("flags a value that looks like a token", () => {
    const result = checkCredentialsInConfig('{ "apiKey": "sk-abcdefghijklmnopqrstuvwxyz" }');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/secret|credential/i);
  });
});

describe("checkBaseDirectory", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when the base directory exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basedir-"));
    roots.push(dir);
    expect(checkBaseDirectory(contextWithBaseDirectory(dir)).ok).toBe(true);
  });

  it("fails naming the missing directory", () => {
    const result = checkBaseDirectory(contextWithBaseDirectory("/definitely/missing/xyz"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/definitely/missing/xyz");
  });
});
