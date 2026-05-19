import { statSync } from "node:fs";

import type { ModelDefinition } from "./config.ts";
import { buildLaunchCommand, resolveSafehouseClearancePath } from "./launchCommand.ts";

function arguments_(
  overrides: Partial<Parameters<typeof buildLaunchCommand>[0]> = {},
): Parameters<typeof buildLaunchCommand>[0] {
  return {
    definition: { cmd: "claude", color: "#fff" } satisfies ModelDefinition,
    promptFile: "/tmp/prompt-team-1/prompt.txt",
    worktreeDir: "/work/repo-a-team-1",
    ...overrides,
  };
}

describe(resolveSafehouseClearancePath, () => {
  it("resolves through Node module resolution to the real safehouse-clearance file", () => {
    const wrapperPath = resolveSafehouseClearancePath();

    expect(wrapperPath).toMatch(/clearance\/safehouse\/safehouse-clearance$/);
    expect(statSync(wrapperPath).isFile()).toBe(true);
  });

  it("wraps resolution failure in a guidance error naming clearance and groundcrew", () => {
    // A non-absolute, non-file-URL baseUrl makes `createRequire` itself throw
    // ERR_INVALID_ARG_VALUE before any node_modules walk, so this assertion is
    // deterministic regardless of globalPaths, NODE_PATH, or $HOME/.node_modules.
    expect(() => resolveSafehouseClearancePath("relative/path/that/createRequire/rejects")).toThrow(
      /@clipboard-health\/clearance.*groundcrew/,
    );
  });
});

describe(buildLaunchCommand, () => {
  it("cd's into the worktree, runs setup, then execs the Safehouse-wrapped agent with the prompt", () => {
    const out = buildLaunchCommand(arguments_());

    expect(out).toContain("cd '/work/repo-a-team-1'");
    expect(out).toContain("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
    expect(out).toContain("rm -rf '/tmp/prompt-team-1'");
    expect(out).toContain("exec '/");
    expect(out).toContain(
      "/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance' claude",
    );
    expect(out).toMatch(/claude "\$_p"$/);
  });

  it("does not double-wrap when cmd already starts with safehouse", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "safehouse claude", color: "#fff" },
      }),
    );

    expect(out).toMatch(/exec safehouse claude "\$_p"$/);
    expect(out).not.toContain("safehouse safehouse");
  });

  it("substitutes {{worktree}} and {{sandbox}} in the agent command", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: {
          cmd: "claude --worktree {{worktree}} --sandbox {{sandbox}}",
          color: "#fff",
        },
      }),
    );

    expect(out).toContain("--worktree '/work/repo-a-team-1'");
    // `{{sandbox}}` is a legacy placeholder; local runs no longer have one.
    expect(out).toContain("--sandbox ''");
    expect(out).not.toContain("{{worktree}}");
    expect(out).not.toContain("{{sandbox}}");
  });

  it("escapes single quotes in worktree paths so the shell quoting survives", () => {
    const out = buildLaunchCommand(
      arguments_({
        worktreeDir: "/work/it's-fine",
        promptFile: "/tmp/it's-fine/prompt.txt",
      }),
    );

    expect(out).toContain(String.raw`cd '/work/it'\''s-fine'`);
    expect(out).toContain(String.raw`_p=$(cat '/tmp/it'\''s-fine/prompt.txt')`);
  });

  it("includes a non-zero setup-status warning", () => {
    const out = buildLaunchCommand(arguments_());

    expect(out).toContain("setup_status=$?");
    expect(out).toContain("groundcrew setup command exited with status $setup_status");
  });

  describe("secretsFile (build-time secret shuttling)", () => {
    it("omits source/unset lines when secretsFile is undefined", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).not.toContain("secrets.env");
      expect(out).not.toContain("unset NPM_TOKEN");
      expect(out).not.toContain("unset BUF_TOKEN");
    });

    it("sources secretsFile before setup and clears the names before exec", () => {
      const out = buildLaunchCommand(arguments_({ secretsFile: "/tmp/prompt-team-1/secrets.env" }));

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupIndex = out.indexOf("setup_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const execIndex = out.indexOf("safehouse-clearance");
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(sourceIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(execIndex).toBeGreaterThan(unsetIndex);
      expect(out).toContain(
        "if [ -f '/tmp/prompt-team-1/secrets.env' ]; then set -a && . '/tmp/prompt-team-1/secrets.env' && set +a; fi",
      );
    });

    it("also sources and clears secrets before the Safehouse-wrapped command", () => {
      const out = buildLaunchCommand(arguments_({ secretsFile: "/tmp/prompt-team-1/secrets.env" }));

      expect(out).toContain(". '/tmp/prompt-team-1/secrets.env'");
      expect(out).toContain("unset NPM_TOKEN BUF_TOKEN");
      expect(out).toMatch(/safehouse-clearance' claude "\$_p"$/);
    });
  });
});
