import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkBaseDirectory,
  checkCredentialsInConfig,
  checkSecretsFilePermissions,
} from "./checks.js";
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

describe("checkSecretsFilePermissions", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function secretsFileWithMode(mode: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
    roots.push(dir);
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, "LINEAR_API_KEY=x\n");
    fs.chmodSync(file, mode);
    return file;
  }

  it("returns nothing when the file does not exist", () => {
    expect(checkSecretsFilePermissions("/no/such/secrets.env", "linux")).toBeUndefined();
  });

  it("returns nothing for a 0600 file", () => {
    const file = secretsFileWithMode(0o600);
    expect(checkSecretsFilePermissions(file, "linux")).toBeUndefined();
  });

  it("warns (as a non-failing note) for a group/other-readable file", () => {
    const file = secretsFileWithMode(0o644);
    const result = checkSecretsFilePermissions(file, "linux");
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true); // a warning, never a failure
    expect(result?.note).toBe(true);
    expect(result?.label).toContain("644");
    expect(result?.label).toContain("chmod 600");
  });

  it("skips the check on Windows (no meaningful POSIX mode)", () => {
    const file = secretsFileWithMode(0o644);
    expect(checkSecretsFilePermissions(file, "win32")).toBeUndefined();
  });
});
