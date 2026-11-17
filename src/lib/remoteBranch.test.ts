import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { deleteRemoteBranchBestEffort } from "./remoteBranch.ts";

const runCommandMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[]) => Promise<string>>(),
);

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  async function runCommandAsync(
    command: string,
    arguments_: readonly string[],
    options: RunCommandOptions & { stdio: "inherit" },
  ): Promise<undefined>;
  async function runCommandAsync(
    command: string,
    arguments_: readonly string[],
    options?: RunCommandOptions & { stdio?: "captured" },
  ): Promise<string>;
  async function runCommandAsync(
    command: string,
    arguments_: readonly string[],
  ): Promise<string | undefined> {
    return await runCommandMock(command, arguments_);
  }
  return { ...actual, runCommandAsync };
});

const config: ResolvedConfig = Object.assign(Object.create(null), {
  git: { remote: "origin", defaultBranch: "main" },
  workspace: { projectDir: "/work" },
});

const TIP = "a".repeat(40);
const LS_REMOTE_ARGUMENTS = [
  "-C",
  "/work/repo-a",
  "ls-remote",
  "--heads",
  "origin",
  "refs/heads/dev-team-1",
];
const CAT_FILE_ARGUMENTS = ["-C", "/work/repo-a", "cat-file", "-e", `${TIP}^{commit}`];
const IS_ANCESTOR_ARGUMENTS = [
  "-C",
  "/work/repo-a",
  "merge-base",
  "--is-ancestor",
  TIP,
  "origin/main",
];
const DELETE_ARGUMENTS = [
  "-C",
  "/work/repo-a",
  "push",
  "--no-verify",
  "origin",
  "--delete",
  "dev-team-1",
];

function fakeGit(
  failing: readonly (readonly string[])[] = [],
  listing = `${TIP}\trefs/heads/dev-team-1\n`,
): void {
  runCommandMock.mockImplementation(async (_command, arguments_) => {
    if (failing.some((candidate) => candidate.join("\0") === arguments_.join("\0"))) {
      throw new Error(`git failed: ${arguments_.join(" ")}`);
    }
    return arguments_.includes("ls-remote") ? listing : "";
  });
}

function deleteCalls(): readonly (readonly string[])[] {
  return runCommandMock.mock.calls
    .map(([, arguments_]) => arguments_)
    .filter((arguments_) => arguments_.includes("--delete"));
}

describe(deleteRemoteBranchBestEffort, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    runCommandMock.mockReset();
    consoleLog = captureConsoleLog();
  });

  afterEach(() => {
    consoleLog.restore();
  });

  const target = { config, repository: "repo-a", branchName: "dev-team-1" };

  it("deletes the branch when its tip is contained in the default branch", async () => {
    fakeGit();

    await deleteRemoteBranchBestEffort(target);

    expect(runCommandMock).toHaveBeenCalledWith("git", LS_REMOTE_ARGUMENTS);
    expect(runCommandMock).toHaveBeenCalledWith("git", IS_ANCESTOR_ARGUMENTS);
    expect(deleteCalls()).toStrictEqual([DELETE_ARGUMENTS]);
  });

  it("keeps the branch and logs why when its tip carries commits beyond the default branch", async () => {
    fakeGit([IS_ANCESTOR_ARGUMENTS]);

    await deleteRemoteBranchBestEffort(target);

    expect(deleteCalls()).toStrictEqual([]);
    expect(consoleLog.output()).toContain("Kept remote branch dev-team-1");
    expect(consoleLog.output()).toContain("not contained in origin/main");
  });

  it("keeps the branch when its tip is not available locally", async () => {
    fakeGit([CAT_FILE_ARGUMENTS]);

    await deleteRemoteBranchBestEffort(target);

    expect(deleteCalls()).toStrictEqual([]);
    expect(runCommandMock).not.toHaveBeenCalledWith("git", IS_ANCESTOR_ARGUMENTS);
    expect(consoleLog.output()).toContain("Kept remote branch dev-team-1");
    expect(consoleLog.output()).toContain("not available locally");
  });

  it("does nothing when the remote has no such branch", async () => {
    fakeGit([], "");

    await deleteRemoteBranchBestEffort(target);

    expect(deleteCalls()).toStrictEqual([]);
    expect(runCommandMock).toHaveBeenCalledOnce();
    expect(consoleLog.output()).not.toContain("Kept remote branch");
  });

  it("keeps the branch without throwing when ls-remote fails", async () => {
    fakeGit([LS_REMOTE_ARGUMENTS]);

    await expect(deleteRemoteBranchBestEffort(target)).resolves.toBeUndefined();

    expect(deleteCalls()).toStrictEqual([]);
    expect(consoleLog.output()).toContain("Kept remote branch dev-team-1");
    expect(consoleLog.output()).toContain("could not read its tip");
  });

  it("does not throw when the delete itself fails", async () => {
    fakeGit([DELETE_ARGUMENTS]);

    await expect(deleteRemoteBranchBestEffort(target)).resolves.toBeUndefined();

    expect(deleteCalls()).toStrictEqual([DELETE_ARGUMENTS]);
  });
});
