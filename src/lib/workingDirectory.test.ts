import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setEnvironmentVariable, snapshotEnvironmentVariables } from "../testHelpers/env.ts";
import { recoverWorkingDirectory, type WorkingDirectoryDeps } from "./workingDirectory.ts";

function missingCwdError(): Error {
  return Object.assign(new Error("ENOENT: process.cwd failed"), { code: "ENOENT" });
}

function createDeps(overrides: Partial<WorkingDirectoryDeps> = {}): WorkingDirectoryDeps {
  return {
    cwd: vi.fn<() => string>(() => {
      throw missingCwdError();
    }),
    chdir: vi.fn<(directory: string) => void>(),
    exists: vi.fn<(directory: string) => boolean>(() => false),
    pwd: undefined,
    home: "/home/user",
    ...overrides,
  };
}

describe(recoverWorkingDirectory, () => {
  it("leaves an accessible working directory untouched", () => {
    const deps = createDeps({ cwd: vi.fn<() => string>(() => "/repo") });

    const actual = recoverWorkingDirectory(deps);

    expect(actual).toBeUndefined();
    expect(deps.chdir).not.toHaveBeenCalled();
  });

  it("moves to the nearest existing ancestor of PWD when the working directory was removed", () => {
    const existing = new Set(["/dev/ClipboardHealth"]);
    const deps = createDeps({
      pwd: "/dev/ClipboardHealth/repo-devop-1/nested",
      exists: vi.fn<(directory: string) => boolean>((directory) => existing.has(directory)),
    });

    const actual = recoverWorkingDirectory(deps);

    expect(actual).toStrictEqual({
      missing: "/dev/ClipboardHealth/repo-devop-1/nested",
      recovered: "/dev/ClipboardHealth",
    });
    expect(deps.chdir).toHaveBeenCalledWith("/dev/ClipboardHealth");
  });

  it("re-enters PWD when the directory was recreated at the same path", () => {
    const deps = createDeps({
      pwd: "/dev/repo",
      exists: vi.fn<(directory: string) => boolean>(() => true),
    });

    const actual = recoverWorkingDirectory(deps);

    expect(actual).toStrictEqual({ missing: "/dev/repo", recovered: "/dev/repo" });
    expect(deps.chdir).toHaveBeenCalledWith("/dev/repo");
  });

  it("falls back to the home directory when PWD is unset", () => {
    const deps = createDeps();

    const actual = recoverWorkingDirectory(deps);

    expect(actual).toStrictEqual({ missing: undefined, recovered: "/home/user" });
    expect(deps.chdir).toHaveBeenCalledWith("/home/user");
  });

  it("falls back to the home directory when chdir into an ancestor fails", () => {
    const deps = createDeps({
      pwd: "/gone/repo",
      exists: vi.fn<(directory: string) => boolean>((directory) => directory === "/gone"),
      chdir: vi.fn<(directory: string) => void>().mockImplementationOnce(() => {
        throw missingCwdError();
      }),
    });

    const actual = recoverWorkingDirectory(deps);

    expect(actual).toStrictEqual({ missing: "/gone/repo", recovered: "/home/user" });
    expect(deps.chdir).toHaveBeenLastCalledWith("/home/user");
  });

  it("rethrows errors other than a missing working directory", () => {
    const expected = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const deps = createDeps({
      cwd: vi.fn<() => string>(() => {
        throw expected;
      }),
    });

    expect(() => recoverWorkingDirectory(deps)).toThrow(expected);
  });

  describe("against the real process", () => {
    let original: string;
    let originalPwd: string | undefined;
    let parent: string;

    beforeEach(() => {
      original = process.cwd();
      originalPwd = snapshotEnvironmentVariables()["PWD"];
      parent = realpathSync(mkdtempSync(path.join(tmpdir(), "groundcrew-cwd-")));
    });

    afterEach(() => {
      process.chdir(original);
      setEnvironmentVariable("PWD", originalPwd ?? original);
      rmSync(parent, { recursive: true, force: true });
    });

    it("recovers from a removed working directory", () => {
      const removed = path.join(parent, "worktree");
      mkdirSync(removed);
      process.chdir(removed);
      setEnvironmentVariable("PWD", removed);
      rmSync(removed, { recursive: true });

      const actual = recoverWorkingDirectory();

      expect(actual).toStrictEqual({ missing: removed, recovered: parent });
      expect(process.cwd()).toBe(parent);
    });
  });
});
