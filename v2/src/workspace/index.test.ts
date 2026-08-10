import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceMetadataError, WorkspaceService } from "./index.js";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
  );
});

describe("WorkspaceService cleanup", () => {
  it("rejects traversal metadata before deleting a branch outside the checkout root", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-workspace-cleanup-"));
    fixtureRoots.push(root);
    const baseDirectory = join(root, "repositories");
    const outsideRepository = join(root, "target");
    const worktreeDirectory = join(root, "worktrees");
    const workspaceDirectory = join(worktreeDirectory, "fixture-eng-123");
    await Promise.all([
      mkdir(baseDirectory, { recursive: true }),
      mkdir(join(workspaceDirectory, ".groundcrew"), { recursive: true }),
      createRepository({ path: outsideRepository }),
    ]);
    await runGit({ arguments: ["branch", "attacker-selected"], cwd: outsideRepository });
    await writeFile(
      join(workspaceDirectory, ".groundcrew", "task.json"),
      JSON.stringify({
        branch: "attacker-selected",
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["../target"],
        version: 1,
      }),
    );
    const workspaces = createWorkspaceService({ baseDirectory, worktreeDirectory });

    const rejected = await workspaces
      .cleanup({
        allowDirty: true,
        record: {
          canonicalTaskId: "fixture:ENG-123",
          repositories: ["target"],
          workspaceDirectory,
        },
        slug: "fixture-eng-123",
      })
      .then(
        () => false,
        () => true,
      );
    const outsideBranchExists = await gitBranchExists({
      branch: "attacker-selected",
      cwd: outsideRepository,
    });

    expect({ outsideBranchExists, rejected }).toEqual({
      outsideBranchExists: true,
      rejected: true,
    });
  });

  it.each(["task.json", "provisioning.json"])(
    "strictly validates %s workspace metadata",
    async (fileName) => {
      const root = await mkdtemp(join(tmpdir(), "groundcrew-workspace-metadata-"));
      fixtureRoots.push(root);
      const baseDirectory = join(root, "repositories");
      const worktreeDirectory = join(root, "worktrees");
      const workspaceDirectory = join(worktreeDirectory, "fixture-eng-123");
      await Promise.all([
        mkdir(baseDirectory, { recursive: true }),
        mkdir(join(workspaceDirectory, ".groundcrew"), { recursive: true }),
      ]);
      await writeFile(
        join(workspaceDirectory, ".groundcrew", fileName),
        JSON.stringify({
          branch: "crew/fixture-eng-123",
          canonicalTaskId: "fixture:ENG-123",
          repositories: [],
          unexpected: true,
          version: 1,
        }),
      );
      const workspaces = createWorkspaceService({ baseDirectory, worktreeDirectory });

      const observed = workspaces.observe({ slug: "fixture-eng-123" });

      await expect(observed).rejects.toBeInstanceOf(WorkspaceMetadataError);
    },
  );

  it("rejects a checkout symlink that resolves outside the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-workspace-symlink-"));
    fixtureRoots.push(root);
    const baseDirectory = join(root, "repositories");
    const outsideRepository = join(root, "target");
    const worktreeDirectory = join(root, "worktrees");
    const workspaceDirectory = join(worktreeDirectory, "fixture-eng-123");
    await Promise.all([
      mkdir(baseDirectory, { recursive: true }),
      mkdir(join(workspaceDirectory, ".groundcrew"), { recursive: true }),
      createRepository({ path: outsideRepository }),
    ]);
    await Promise.all([
      runGit({
        arguments: ["branch", "crew/fixture-eng-123"],
        cwd: outsideRepository,
      }),
      symlink(outsideRepository, join(baseDirectory, "linked"), "dir"),
    ]);
    await writeFile(
      join(workspaceDirectory, ".groundcrew", "task.json"),
      JSON.stringify({
        branch: "crew/fixture-eng-123",
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["linked"],
        version: 1,
      }),
    );
    const workspaces = createWorkspaceService({ baseDirectory, worktreeDirectory });

    const cleanup = workspaces.cleanup({
      allowDirty: true,
      record: {
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["linked"],
        workspaceDirectory,
      },
      slug: "fixture-eng-123",
    });

    await expect(cleanup).rejects.toBeInstanceOf(WorkspaceMetadataError);
    await expect(
      gitBranchExists({ branch: "crew/fixture-eng-123", cwd: outsideRepository }),
    ).resolves.toBe(true);
  });

  it.each([
    {
      branchToPreserve: "crew/fixture-eng-123",
      marker: {
        branch: "crew/fixture-eng-123",
        canonicalTaskId: "fixture:OTHER",
        repositories: ["safe"],
        version: 1,
      },
      fileName: "task.json",
      repositoryToPreserve: "safe",
      subject: "canonical task",
    },
    {
      branchToPreserve: "attacker-selected",
      marker: {
        branch: "attacker-selected",
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["safe"],
        version: 1,
      },
      fileName: "task.json",
      repositoryToPreserve: "safe",
      subject: "branch",
    },
    {
      branchToPreserve: "crew/fixture-eng-123",
      marker: {
        branch: "crew/fixture-eng-123",
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["target"],
        version: 1,
      },
      fileName: "task.json",
      repositoryToPreserve: "target",
      subject: "repository set",
    },
    {
      branchToPreserve: "crew/fixture-eng-123",
      fileName: "provisioning.json",
      marker: {
        branch: "crew/fixture-eng-123",
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["target"],
        version: 1,
      },
      repositoryToPreserve: "target",
      subject: "recovery repository set",
    },
  ])("rejects a $subject mismatch against the durable run", async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-workspace-run-mismatch-"));
    fixtureRoots.push(root);
    const baseDirectory = join(root, "repositories");
    const safeRepository = join(baseDirectory, "safe");
    const targetRepository = join(baseDirectory, "target");
    const worktreeDirectory = join(root, "worktrees");
    const workspaceDirectory = join(worktreeDirectory, "fixture-eng-123");
    await Promise.all([
      createRepository({ path: safeRepository }),
      createRepository({ path: targetRepository }),
      mkdir(join(workspaceDirectory, ".groundcrew"), { recursive: true }),
    ]);
    await Promise.all([
      runGit({ arguments: ["branch", "crew/fixture-eng-123"], cwd: safeRepository }),
      runGit({ arguments: ["branch", "attacker-selected"], cwd: safeRepository }),
      runGit({ arguments: ["branch", "crew/fixture-eng-123"], cwd: targetRepository }),
    ]);
    await writeFile(
      join(workspaceDirectory, ".groundcrew", testCase.fileName),
      JSON.stringify(testCase.marker),
    );
    const workspaces = createWorkspaceService({ baseDirectory, worktreeDirectory });

    const cleanup = workspaces.cleanup({
      allowDirty: true,
      record: {
        canonicalTaskId: "fixture:ENG-123",
        repositories: ["safe"],
        workspaceDirectory,
      },
      slug: "fixture-eng-123",
    });

    await expect(cleanup).rejects.toBeInstanceOf(WorkspaceMetadataError);
    await expect(
      gitBranchExists({
        branch: testCase.branchToPreserve,
        cwd: join(baseDirectory, testCase.repositoryToPreserve),
      }),
    ).resolves.toBe(true);
  });

  it("rejects task and recovery markers with different workspace identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-workspace-identity-"));
    fixtureRoots.push(root);
    const baseDirectory = join(root, "repositories");
    const worktreeDirectory = join(root, "worktrees");
    const workspaceDirectory = join(worktreeDirectory, "fixture-eng-123");
    const metadataDirectory = join(workspaceDirectory, ".groundcrew");
    await Promise.all([
      mkdir(baseDirectory, { recursive: true }),
      mkdir(metadataDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(metadataDirectory, "task.json"),
        JSON.stringify({
          branch: "crew/fixture-eng-123",
          canonicalTaskId: "fixture:ENG-123",
          repositories: [],
          version: 1,
        }),
      ),
      writeFile(
        join(metadataDirectory, "provisioning.json"),
        JSON.stringify({
          branch: "crew/fixture-other",
          canonicalTaskId: "fixture:OTHER",
          repositories: [],
          version: 1,
        }),
      ),
    ]);
    const workspaces = createWorkspaceService({ baseDirectory, worktreeDirectory });

    const observed = workspaces.observe({ slug: "fixture-eng-123" });

    await expect(observed).rejects.toBeInstanceOf(WorkspaceMetadataError);
  });
});

function createWorkspaceService(input: {
  readonly baseDirectory: string;
  readonly worktreeDirectory: string;
}): WorkspaceService {
  return new WorkspaceService({
    config: {
      baseDirectory: input.baseDirectory,
      repositories: {},
      worktreeDirectory: input.worktreeDirectory,
    },
    environment: process.env,
    git: { branchPrefix: "crew", defaultBranch: "main", remote: "origin" },
  });
}

async function createRepository(input: { readonly path: string }): Promise<void> {
  await mkdir(input.path, { recursive: true });
  await runGit({ arguments: ["init", "--initial-branch=main"], cwd: input.path });
  await writeFile(join(input.path, "README.md"), "fixture\n");
  await runGit({ arguments: ["add", "README.md"], cwd: input.path });
  await runGit({
    arguments: [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    cwd: input.path,
  });
}

async function gitBranchExists(input: {
  readonly branch: string;
  readonly cwd: string;
}): Promise<boolean> {
  const result = await execFileAsync(
    "git",
    ["show-ref", "--verify", `refs/heads/${input.branch}`],
    { cwd: input.cwd },
  ).catch(() => undefined);
  return result !== undefined;
}

async function runGit(input: {
  readonly arguments: readonly string[];
  readonly cwd: string;
}): Promise<void> {
  await execFileAsync("git", [...input.arguments], { cwd: input.cwd });
}
