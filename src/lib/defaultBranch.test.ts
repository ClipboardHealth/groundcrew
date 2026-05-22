import type { RunCommandOptions } from "./commandRunner.ts";
import { resolveDefaultBranch } from "./defaultBranch.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mock shares one recorder across the sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

describe(resolveDefaultBranch, () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("returns the branch reported by `git symbolic-ref` (stripping the remote prefix)", async () => {
    runCommandMock.mockReturnValue("origin/master\n");

    const actual = await resolveDefaultBranch({
      repoDir: "/work/repo-a",
      remote: "origin",
      fallback: "main",
    });

    expect(actual).toBe("master");
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/work/repo-a", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      {},
    );
  });

  it("respects a non-default remote name", async () => {
    runCommandMock.mockReturnValue("upstream/develop\n");

    const actual = await resolveDefaultBranch({
      repoDir: "/work/repo-a",
      remote: "upstream",
      fallback: "main",
    });

    expect(actual).toBe("develop");
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/work/repo-a", "symbolic-ref", "--short", "refs/remotes/upstream/HEAD"],
      {},
    );
  });

  it("falls back when `git symbolic-ref` exits non-zero (origin/HEAD unset)", async () => {
    runCommandMock.mockImplementation(() => {
      throw new Error(
        "Command failed: git symbolic-ref --short refs/remotes/origin/HEAD\nExit status: 1",
      );
    });

    const actual = await resolveDefaultBranch({
      repoDir: "/work/repo-a",
      remote: "origin",
      fallback: "trunk",
    });

    expect(actual).toBe("trunk");
  });

  it("falls back when the output does not start with `<remote>/`", async () => {
    runCommandMock.mockReturnValue("refs/heads/somewhere-else\n");

    const actual = await resolveDefaultBranch({
      repoDir: "/work/repo-a",
      remote: "origin",
      fallback: "main",
    });

    expect(actual).toBe("main");
  });

  it("falls back when the branch portion is empty", async () => {
    runCommandMock.mockReturnValue("origin/\n");

    const actual = await resolveDefaultBranch({
      repoDir: "/work/repo-a",
      remote: "origin",
      fallback: "main",
    });

    expect(actual).toBe("main");
  });

  it("passes the abort signal through to runCommandAsync", async () => {
    runCommandMock.mockReturnValue("origin/main\n");
    const controller = new AbortController();

    await resolveDefaultBranch({
      repoDir: "/work/repo-a",
      remote: "origin",
      fallback: "main",
      signal: controller.signal,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/work/repo-a", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { signal: controller.signal },
    );
  });

  it("re-throws when the call fails after the signal aborted", async () => {
    const controller = new AbortController();
    runCommandMock.mockImplementation(() => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      resolveDefaultBranch({
        repoDir: "/work/repo-a",
        remote: "origin",
        fallback: "main",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
