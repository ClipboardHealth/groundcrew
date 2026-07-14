import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { forceRemoveDirectory, isRecoverableRemovalError } from "./worktrees.ts";

function errorWithCode(code: string): Error {
  const error = new Error(`${code}: simulated removal failure`);
  Object.assign(error, { code });
  return error;
}

function errorWithNumericCode(): Error {
  const error = new Error("numeric code");
  Object.assign(error, { code: 42 });
  return error;
}

describe("isRecoverableRemovalError", () => {
  it("recognizes the recoverable filesystem error codes", () => {
    expect(isRecoverableRemovalError(errorWithCode("ENOTEMPTY"))).toBe(true);
    expect(isRecoverableRemovalError(errorWithCode("EBUSY"))).toBe(true);
  });

  it("rejects a non-recoverable filesystem error code", () => {
    expect(isRecoverableRemovalError(errorWithCode("EACCES"))).toBe(false);
  });

  it("rejects values that are not Error instances", () => {
    expect(isRecoverableRemovalError("ENOTEMPTY")).toBe(false);
    expect(isRecoverableRemovalError({ code: "ENOTEMPTY" })).toBe(false);
  });

  it("rejects an Error without a code", () => {
    expect(isRecoverableRemovalError(new Error("no code"))).toBe(false);
  });

  it("rejects an Error whose code is not a string", () => {
    expect(isRecoverableRemovalError(errorWithNumericCode())).toBe(false);
  });
});

describe("forceRemoveDirectory", () => {
  it("removes a real nested directory tree with the default remover", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "groundcrew-force-remove-"));
    mkdirSync(path.join(root, "left", "deep"), { recursive: true });
    writeFileSync(path.join(root, "left", "deep", "leaf.txt"), "leaf");

    await forceRemoveDirectory(root);

    expect(existsSync(root)).toBe(false);
  });

  it("retries a recoverable failure until removal succeeds", async () => {
    let attemptsMade = 0;
    const remove = vi.fn<(target: string) => void>(() => {
      attemptsMade += 1;
      // oxlint-disable-next-line vitest/no-conditional-in-test -- simulate a transient ENOTEMPTY that clears after two tries.
      if (attemptsMade < 3) {
        throw errorWithCode("ENOTEMPTY");
      }
    });

    await forceRemoveDirectory("/irrelevant", { remove, attempts: 5, delayMs: 1 });

    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("rethrows a non-recoverable error without retrying", async () => {
    const remove = vi.fn<(target: string) => void>(() => {
      throw errorWithCode("EACCES");
    });

    await expect(
      forceRemoveDirectory("/irrelevant", { remove, attempts: 5, delayMs: 1 }),
    ).rejects.toThrow("EACCES");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts and rethrows the last recoverable error", async () => {
    const remove = vi.fn<(target: string) => void>(() => {
      throw errorWithCode("EBUSY");
    });

    await expect(
      forceRemoveDirectory("/irrelevant", { remove, attempts: 3, delayMs: 1 }),
    ).rejects.toThrow("EBUSY");
    expect(remove).toHaveBeenCalledTimes(3);
  });
});
