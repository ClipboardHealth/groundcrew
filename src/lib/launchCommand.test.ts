import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_SECRET_NAMES, type ModelDefinition } from "./config.ts";
import {
  buildLaunchCommand,
  resolveSafehouseClearancePath,
  SETUP_COMMAND,
} from "./launchCommand.ts";

function arguments_(
  overrides: Partial<Parameters<typeof buildLaunchCommand>[0]> = {},
): Parameters<typeof buildLaunchCommand>[0] {
  return {
    definition: { cmd: "claude", color: "#fff" } satisfies ModelDefinition,
    promptFile: "/tmp/prompt-team-1/prompt.txt",
    worktreeDir: "/work/repo-a-team-1",
    runner: "safehouse",
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

function runSetupCommand(cwd: string): number | undefined {
  return spawnSync("sh", ["-c", SETUP_COMMAND], { cwd }).status ?? undefined;
}

describe(buildLaunchCommand, () => {
  describe(SETUP_COMMAND, () => {
    it("is a successful no-op when the repo setup hook is absent", () => {
      const worktreeDir = mkdtempSync(join(tmpdir(), "groundcrew-no-setup-"));
      try {
        const actual = runSetupCommand(worktreeDir);

        expect(actual).toBe(0);
      } finally {
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    });

    it("preserves the repo setup hook status when the hook exists", () => {
      const worktreeDir = mkdtempSync(join(tmpdir(), "groundcrew-failing-setup-"));
      try {
        mkdirSync(join(worktreeDir, ".groundcrew"));
        writeFileSync(join(worktreeDir, ".groundcrew", "setup.sh"), "exit 7\n");

        const actual = runSetupCommand(worktreeDir);

        expect(actual).toBe(7);
      } finally {
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  });

  it("cd's into the worktree on the host, then runs setup and the agent inside the Safehouse wrap", () => {
    const out = buildLaunchCommand(arguments_());

    expect(out).toContain("cd '/work/repo-a-team-1'");
    expect(out).toContain("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
    expect(out).toContain("rm -rf '/tmp/prompt-team-1'");
    expect(out).toContain(
      "/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance' sh -lc",
    );
    // Setup now runs inside the wrap (fs-isolated + clearance egress), not on the host.
    expect(out).toContain(SETUP_COMMAND);
    expect(out).toContain(`exec claude "$@"`);
    expect(out).toMatch(/sh "\$_p"$/);
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

    // The agent command is single-quoted for the wrap's `sh -lc`, so embedded
    // worktree quotes are escaped via the `'\''` close-escape-reopen dance.
    expect(out).toContain(String.raw`--worktree '\''/work/repo-a-team-1'\''`);
    // `{{sandbox}}` is a legacy placeholder; local runs no longer have one.
    expect(out).toContain(String.raw`--sandbox '\'''\''`);
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
    it("omits source/unset/env-pass when secretsFile is undefined", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).not.toContain("secrets.env");
      expect(out).not.toContain("unset NPM_TOKEN");
      expect(out).not.toContain("unset BUF_TOKEN");
      expect(out).not.toContain("--env-pass");
    });

    it("sources secrets on the host, forwards them via --env-pass, and clears them inside the wrap before the agent", () => {
      const out = buildLaunchCommand(arguments_({ secretsFile: "/tmp/prompt-team-1/secrets.env" }));

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const wrapIndex = out.indexOf("safehouse-clearance");
      const setupIndex = out.indexOf("setup_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const agentIndex = out.indexOf(`exec claude "$@"`);

      // Secrets are sourced into the host shell before the wrap so Safehouse can
      // forward them in; setup runs inside the wrap; the agent never inherits them.
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(wrapIndex).toBeGreaterThan(sourceIndex);
      expect(out).toContain("--env-pass=NPM_TOKEN,BUF_TOKEN");
      expect(setupIndex).toBeGreaterThan(wrapIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(agentIndex).toBeGreaterThan(unsetIndex);
      expect(out).toContain(
        "if [ -f '/tmp/prompt-team-1/secrets.env' ]; then set -a && . '/tmp/prompt-team-1/secrets.env' && set +a; fi",
      );
    });

    it("does not unset secrets on the host (the wrap needs them to forward)", () => {
      const out = buildLaunchCommand(arguments_({ secretsFile: "/tmp/prompt-team-1/secrets.env" }));

      // The only unset is inside the wrapped `sh -lc`, after the wrapper token.
      const hostSegment = out.slice(0, out.indexOf("safehouse-clearance"));
      expect(hostSegment).not.toContain("unset NPM_TOKEN");
      expect(out).toMatch(/sh "\$_p"$/);
    });
  });

  describe("runner='none'", () => {
    it("execs the agent directly without the safehouse wrapper", () => {
      const out = buildLaunchCommand(arguments_({ runner: "none" }));

      expect(out).not.toContain("safehouse-clearance");
      expect(out).toMatch(/exec claude "\$_p"$/);
    });

    it("sources and clears build secrets on the host (no sandbox to forward into)", () => {
      const out = buildLaunchCommand(
        arguments_({ runner: "none", secretsFile: "/tmp/prompt-team-1/secrets.env" }),
      );

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupIndex = out.indexOf("setup_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const execIndex = out.indexOf(`exec claude "$_p"`);
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(sourceIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(execIndex).toBeGreaterThan(unsetIndex);
      expect(out).not.toContain("--env-pass");
    });
  });

  describe("EXIT-trap promptDir cleanup", () => {
    it("arms the `trap 'rm -rf <promptDir>' EXIT` before `cd` so a failed `cd` still wipes promptDir", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).toContain(String.raw`trap 'rm -rf '\''/tmp/prompt-team-1'\''' EXIT`);
      const trapIndex = out.indexOf("trap 'rm -rf");
      const cdIndex = out.indexOf("cd '/work/repo-a-team-1'");
      const setupIndex = out.indexOf("setup_status=$?");
      expect(trapIndex).toBeGreaterThan(-1);
      expect(cdIndex).toBeGreaterThan(trapIndex);
      expect(setupIndex).toBeGreaterThan(cdIndex);
    });

    it("includes the same trap as the first link of the sdx chain", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: { cmd: "claude", color: "#fff", sandbox: { agent: "claude" } },
          runner: "sdx",
          sandboxName: "groundcrew-claude",
        }),
      );

      expect(out).toMatch(/^trap 'rm -rf '\\''\/tmp\/prompt-team-1'\\''' EXIT/);
    });

    it("double-escapes apostrophes in promptDir so the trap arg survives both quote layers", () => {
      const out = buildLaunchCommand(
        arguments_({
          promptFile: "/tmp/it's-fine/prompt.txt",
        }),
      );

      expect(out).toContain(String.raw`trap 'rm -rf '\''/tmp/it'\''\'\'''\''s-fine'\''' EXIT`);
    });

    it("wipes promptDir when preLaunch fails before the explicit `rm -rf` would run", () => {
      const promptDir = mkdtempSync(join(tmpdir(), "groundcrew-trap-cleanup-"));
      const promptFile = join(promptDir, "prompt.txt");
      const secretsFile = join(promptDir, "secrets.env");
      const worktreeDir = mkdtempSync(join(tmpdir(), "groundcrew-trap-worktree-"));
      try {
        writeFileSync(promptFile, "the prompt body\n");
        writeFileSync(secretsFile, "NPM_TOKEN='leaked'\n");

        const out = buildLaunchCommand(
          arguments_({
            runner: "none",
            promptFile,
            worktreeDir,
            secretsFile,
            definition: {
              cmd: "echo never-reached",
              color: "#fff",
              preLaunch: "exit 7",
            },
          }),
        );

        const result = spawnSync("sh", ["-c", out]);
        expect(result.status).toBe(7);
        expect(() => statSync(promptDir)).toThrow(/ENOENT/);
      } finally {
        rmSync(promptDir, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    });

    it("wipes promptDir under the safehouse runner when preLaunch fails before the wrap exec", () => {
      const promptDir = mkdtempSync(join(tmpdir(), "groundcrew-trap-safehouse-"));
      const promptFile = join(promptDir, "prompt.txt");
      const worktreeDir = mkdtempSync(join(tmpdir(), "groundcrew-trap-safehouse-wt-"));
      try {
        writeFileSync(promptFile, "the prompt body\n");

        const out = buildLaunchCommand(
          arguments_({
            runner: "safehouse",
            promptFile,
            worktreeDir,
            definition: {
              cmd: "echo never-reached",
              color: "#fff",
              preLaunch: "exit 9",
            },
          }),
        );

        // preLaunch aborts before the `exec safehouse-clearance …` link, so we
        // never invoke the real wrapper here — the EXIT trap is what we're
        // proving fires.
        const result = spawnSync("sh", ["-c", out]);
        expect(result.status).toBe(9);
        expect(() => statSync(promptDir)).toThrow(/ENOENT/);
      } finally {
        rmSync(promptDir, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  });

  describe("preLaunch", () => {
    const baseline = buildLaunchCommand(arguments_());

    it("omits preLaunch when undefined (byte-identical to baseline)", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).toBe(baseline);
    });

    it("runs preLaunch on the host shell after the secrets source and before reading the prompt", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunch: "export FOO=bar",
          },
          secretsFile: "/tmp/prompt-team-1/secrets.env",
        }),
      );

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const preLaunchIndex = out.indexOf("export FOO=bar");
      const readPromptIndex = out.indexOf("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
      const execIndex = out.indexOf("safehouse-clearance");
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(preLaunchIndex).toBeGreaterThan(sourceIndex);
      expect(readPromptIndex).toBeGreaterThan(preLaunchIndex);
      expect(execIndex).toBeGreaterThan(readPromptIndex);
      // `unset NPM_TOKEN BUF_TOKEN` now lives inside the Safehouse wrap (after
      // setup) rather than on the host, so the host chain shouldn't contain
      // it before the exec.
      expect(out.slice(0, execIndex)).not.toContain("unset NPM_TOKEN BUF_TOKEN");
    });

    it("runs preLaunch without double-wrapping when cmd already starts with safehouse", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: {
            cmd: "safehouse claude",
            color: "#fff",
            preLaunch: "export FOO=bar",
          },
        }),
      );

      expect(out).toContain("export FOO=bar");
      expect(out).toMatch(/exec safehouse claude "\$_p"$/);
      expect(out).not.toContain("safehouse safehouse");
    });

    it("runs preLaunch with runner='none' without the safehouse wrapper", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunch: "export FOO=bar",
          },
        }),
      );

      expect(out).toContain("export FOO=bar");
      expect(out).not.toContain("safehouse-clearance");
      expect(out).toMatch(/exec claude "\$_p"$/);
    });

    it("substitutes {{worktree}} inside preLaunch", () => {
      const out = buildLaunchCommand(
        arguments_({
          worktreeDir: "/work/repo-a-team-1",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunch: "cd {{worktree}} && echo ok",
          },
        }),
      );

      expect(out).toContain("cd '/work/repo-a-team-1' && echo ok");
      expect(out).not.toContain("{{worktree}}");
    });

    it("throws when preLaunch is set with runner='sdx'", () => {
      expect(() =>
        buildLaunchCommand(
          arguments_({
            runner: "sdx",
            sandboxName: "groundcrew-repo-a-claude",
            definition: {
              cmd: "claude",
              color: "#fff",
              sandbox: { agent: "claude" },
              preLaunch: "export FOO=bar",
            },
          }),
        ),
      ).toThrow(/preLaunch is not yet supported for runner='sdx'/);
    });
  });

  describe("preLaunchEnv", () => {
    it("appends preLaunchEnv names to --env-pass when secretsFile is also staged", () => {
      const out = buildLaunchCommand(
        arguments_({
          secretsFile: "/tmp/prompt-team-1/secrets.env",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunchEnv: ["SESSION_TOKEN", "TEAM_ID"],
          },
        }),
      );

      expect(out).toContain(`--env-pass=${BUILD_SECRET_NAMES.join(",")},SESSION_TOKEN,TEAM_ID `);
    });

    it("emits a standalone --env-pass when no secretsFile is staged", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunchEnv: ["SESSION_TOKEN"],
          },
        }),
      );

      expect(out).toContain("--env-pass=SESSION_TOKEN ");
      // No build-secret names should sneak in.
      for (const name of BUILD_SECRET_NAMES) {
        expect(out).not.toContain(name);
      }
    });

    it("omits --env-pass entirely when preLaunchEnv is an empty array and there is no secretsFile", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: { cmd: "claude", color: "#fff", preLaunchEnv: [] },
        }),
      );

      expect(out).not.toContain("--env-pass");
    });

    it("throws when preLaunchEnv is set with runner='sdx'", () => {
      expect(() =>
        buildLaunchCommand(
          arguments_({
            runner: "sdx",
            sandboxName: "groundcrew-repo-a-claude",
            definition: {
              cmd: "claude",
              color: "#fff",
              sandbox: { agent: "claude" },
              preLaunchEnv: ["SESSION_TOKEN"],
            },
          }),
        ),
      ).toThrow(/preLaunchEnv is not yet supported for runner='sdx'/);
    });

    it("throws when preLaunchEnv is set with a cmd that already starts with safehouse", () => {
      expect(() =>
        buildLaunchCommand(
          arguments_({
            definition: {
              cmd: "safehouse --env-pass=OTHER my-agent",
              color: "#fff",
              preLaunchEnv: ["SESSION_TOKEN"],
            },
          }),
        ),
      ).toThrow(/preLaunchEnv cannot be injected when `cmd` starts with `safehouse`/);
    });

    it("does not throw on runner='none' with preLaunchEnv (exports already inherit)", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunchEnv: ["SESSION_TOKEN"],
          },
        }),
      );

      // runner='none' goes through the unwrapped host path — no wrap, no flag.
      expect(out).not.toContain("--env-pass");
    });
  });

  describe("runner='sdx'", () => {
    function sdxArguments(
      overrides: Partial<Parameters<typeof buildLaunchCommand>[0]> = {},
    ): Parameters<typeof buildLaunchCommand>[0] {
      return arguments_({
        definition: {
          cmd: "claude",
          color: "#fff",
          sandbox: { agent: "claude" },
        },
        runner: "sdx",
        sandboxName: "groundcrew-claude",
        ...overrides,
      });
    }

    it("wraps the agent in `sbx exec -it -w <worktree> <sandbox> sh -lc <setup; exec agent>`", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).toContain(
        "exec sbx exec -it -w '/work/repo-a-team-1' 'groundcrew-claude' sh -lc",
      );
      expect(out).toContain("exec claude");
      expect(out).toMatch(/sh "\$_p"$/);
    });

    it("uses the per-model sandbox setupCommand override when configured", () => {
      const out = buildLaunchCommand(
        sdxArguments({
          definition: {
            cmd: "claude",
            color: "#fff",
            sandbox: { agent: "claude", setupCommand: "echo custom-setup" },
          },
        }),
      );

      expect(out).toContain("echo custom-setup");
    });

    it("defaults to the .groundcrew/setup.sh convention when no sandbox setupCommand override is set", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).toContain(SETUP_COMMAND);
      expect(out).not.toContain(".claude/setup.sh");
      expect(out).not.toContain("npm clean-install");
    });

    it("substitutes {{sandbox}} in the agent command with the sandbox name", () => {
      const out = buildLaunchCommand(
        sdxArguments({
          definition: {
            cmd: "claude --sandbox {{sandbox}} --worktree {{worktree}}",
            color: "#fff",
            sandbox: { agent: "claude" },
          },
        }),
      );

      // The inner agent command is single-quoted for `sh -lc`, so embedded
      // sandbox / worktree quotes are escaped via the `'\''` close-escape-reopen
      // dance — `groundcrew-claude` still lands as `--sandbox`'s value.
      expect(out).toContain(String.raw`--sandbox '\''groundcrew-claude'\''`);
      expect(out).toContain(String.raw`--worktree '\''/work/repo-a-team-1'\''`);
      expect(out).not.toContain("{{sandbox}}");
      expect(out).not.toContain("{{worktree}}");
    });

    it("forwards build-time secret names into the sandbox via `-e KEY` passthrough flags", () => {
      const out = buildLaunchCommand(
        sdxArguments({ secretsFile: "/tmp/prompt-team-1/secrets.env" }),
      );

      expect(out).toContain(". '/tmp/prompt-team-1/secrets.env'");
      expect(out).toContain("-e NPM_TOKEN -e BUF_TOKEN");
      expect(out).toContain("unset NPM_TOKEN BUF_TOKEN");
    });

    it("omits -e KEY flags when no secretsFile is staged", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).not.toContain("-e NPM_TOKEN");
      expect(out).not.toContain("-e BUF_TOKEN");
    });
  });
});
