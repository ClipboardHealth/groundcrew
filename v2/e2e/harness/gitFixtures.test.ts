import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  branchExists,
  commitSubjects,
  createRepo,
  currentBranch,
  isDirty,
  worktreeList,
  writeAndCommit,
} from "./gitFixtures.js";
import { withScenario } from "./scenario.js";

describe("gitFixtures", () => {
  it("produces a cloneable repo with a seeded origin/main", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      expect(fs.existsSync(path.join(clonePath, "README.md"))).toBe(true);
      expect(await currentBranch({ scenario, repoDirectory: clonePath })).toBe("main");

      const subjects = await commitSubjects({ scenario, repoDirectory: clonePath });
      expect(subjects).toContain("initial commit");
      expect(subjects).toContain("second commit");
    });
  });

  it("reports branch existence and worktree listing", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      expect(await branchExists({ scenario, repoDirectory: clonePath, branch: "main" })).toBe(
        true,
      );
      expect(
        await branchExists({ scenario, repoDirectory: clonePath, branch: "does-not-exist" }),
      ).toBe(false);

      const worktrees = await worktreeList({ scenario, repoDirectory: clonePath });
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]?.branch).toBe("main");
    });
  });

  it("tracks dirty state before and after a commit", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      expect(await isDirty({ scenario, repoDirectory: clonePath })).toBe(false);

      fs.writeFileSync(path.join(clonePath, "scratch.txt"), "wip\n");
      expect(await isDirty({ scenario, repoDirectory: clonePath })).toBe(true);

      await writeAndCommit({
        scenario,
        repoDirectory: clonePath,
        files: { "scratch.txt": "done\n" },
        message: "third commit",
      });
      expect(await isDirty({ scenario, repoDirectory: clonePath })).toBe(false);
      expect(await commitSubjects({ scenario, repoDirectory: clonePath })).toContain(
        "third commit",
      );
    });
  });
});
