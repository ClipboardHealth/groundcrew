import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelDefinition } from "./config.ts";
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

function stepMarker(name: string): string {
  return `echo '[groundcrew] step: ${name}' >&2`;
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

  it("runs setup under plain Safehouse, then runs only the agent through the profile shim", () => {
    const out = buildLaunchCommand(arguments_());

    const setupWrapIndex = out.indexOf("safehouse-clearance' sh -c");
    const setupIndex = out.indexOf(SETUP_COMMAND);
    const shimIndex = out.indexOf("_safehouse_shim_dir=$(mktemp");
    const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
    const agentIndex = out.indexOf(`exec claude "$@"`);

    expect(out).toContain("cd '/work/repo-a-team-1'");
    expect(out).toContain("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
    expect(out).toContain("rm -rf '/tmp/prompt-team-1'");
    expect(out).toContain(
      "/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance' sh -c",
    );
    expect(out).toContain(
      '/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance\' "$_safehouse_shim" -c',
    );
    expect(out).not.toContain("--enable=all-agents");
    expect(out).toContain(SETUP_COMMAND);
    expect(out).toContain(`exec claude "$@"`);
    expect(out).toContain('sh "$_p"; _safehouse_status=$?');
    expect(setupWrapIndex).toBeGreaterThan(-1);
    expect(setupIndex).toBeGreaterThan(setupWrapIndex);
    expect(shimIndex).toBeGreaterThan(setupIndex);
    expect(agentWrapIndex).toBeGreaterThan(shimIndex);
    expect(agentIndex).toBeGreaterThan(agentWrapIndex);
    expect(out.slice(agentWrapIndex)).not.toContain(SETUP_COMMAND);
  });

  it("uses an agent-named shell shim so Safehouse applies only the matching agent profile", () => {
    const out = buildLaunchCommand(arguments_());

    expect(out).toContain('_safehouse_shim_dir=$(mktemp -d "');
    expect(out).toContain('/groundcrew-safehouse-XXXXXX")');
    expect(out).toContain("trap 'rm -rf \"$_safehouse_shim_dir\"' EXIT");
    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain('ln -s /bin/sh "$_safehouse_shim"');
    expect(out).toContain('"$_safehouse_shim" -c');
    expect(out).not.toContain("--enable=all-agents");
  });

  it("infers the Safehouse profile command from an absolute agent path", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "/Users/dev/.local/bin/claude --permission-mode auto", color: "#fff" },
      }),
    );

    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain('exec /Users/dev/.local/bin/claude --permission-mode auto "$@"');
  });

  it("skips `env` environment assignments when inferring the Safehouse profile command", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: {
          cmd: "env ANTHROPIC_MODEL=sonnet claude --permission-mode auto",
          color: "#fff",
        },
      }),
    );

    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain('exec env ANTHROPIC_MODEL=sonnet claude --permission-mode auto "$@"');
  });

  it("skips an `env --` delimiter when inferring the Safehouse profile command", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: {
          cmd: "env -- claude --permission-mode auto",
          color: "#fff",
        },
      }),
    );

    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain('exec env -- claude --permission-mode auto "$@"');
  });

  it("skips leading environment assignments when inferring the Safehouse profile command", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: {
          cmd: "ANTHROPIC_MODEL=sonnet claude --permission-mode auto",
          color: "#fff",
        },
      }),
    );

    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain('exec ANTHROPIC_MODEL=sonnet claude --permission-mode auto "$@"');
  });

  it("skips `env` and quoted environment assignments when inferring the Safehouse profile command", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: {
          cmd: String.raw`env ANTHROPIC_MODEL='claude 3' claude  --permission-mode auto`,
          color: "#fff",
        },
      }),
    );

    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain(String.raw`ANTHROPIC_MODEL='\''claude 3'\'' claude`);
  });

  it("fails loudly when the Safehouse profile command cannot be inferred", () => {
    expect(() =>
      buildLaunchCommand(
        arguments_({
          definition: { cmd: "env ANTHROPIC_MODEL=sonnet", color: "#fff" },
        }),
      ),
    ).toThrow(/Cannot infer Safehouse agent profile command/);

    expect(() =>
      buildLaunchCommand(
        arguments_({
          definition: { cmd: "   ", color: "#fff" },
        }),
      ),
    ).toThrow(/Cannot infer Safehouse agent profile command/);
  });

  it("rejects unsafe inferred Safehouse profile command names", () => {
    expect(() =>
      buildLaunchCommand(
        arguments_({
          definition: { cmd: String.raw`claude\ code --permission-mode auto`, color: "#fff" },
        }),
      ),
    ).toThrow(/Cannot use "claude code" as a Safehouse agent profile command name/);
  });

  it("does not double-wrap when cmd already starts with safehouse", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "safehouse claude", color: "#fff" },
      }),
    );

    expect(out).toMatch(/safehouse claude "\$_p"$/);
    expect(out).not.toContain("safehouse safehouse");
    // A bring-your-own-safehouse cmd owns its sandbox flags; groundcrew must
    // not splice its own --enable into a command it does not control.
    expect(out).not.toContain("--enable=all-agents");
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

    // The agent command is single-quoted for the wrap's `sh -c`, so embedded
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

  // The EXIT trap / no-exec diagnostics live on the unwrapped host path only;
  // safehouse and sdx hand off via `exec` into a wrapper/sandbox.
  describe("EXIT trap (runner='none')", () => {
    const noneArguments = (
      overrides: Partial<Parameters<typeof buildLaunchCommand>[0]> = {},
    ): Parameters<typeof buildLaunchCommand>[0] => arguments_({ runner: "none", ...overrides });

    it("installs an EXIT trap that echoes the exit code with a [groundcrew] sentinel", () => {
      const out = buildLaunchCommand(noneArguments());

      expect(out).toContain(`trap 'echo "[groundcrew] exit=$?" >&2' EXIT`);
    });

    it("does not exec the agent command (so the EXIT trap fires when the agent returns)", () => {
      const out = buildLaunchCommand(noneArguments());

      // The "exec" keyword would replace the shell, preventing the trap from firing.
      expect(out).not.toMatch(/(?:^|[\s&;])exec\s/);
    });

    it("places the trap at the head of the chain so it's installed before any step can fail", () => {
      const out = buildLaunchCommand(noneArguments());

      const trapIndex = out.indexOf("trap 'echo");
      const firstCdIndex = out.indexOf("cd '/work");
      expect(trapIndex).toBeGreaterThan(-1);
      expect(firstCdIndex).toBeGreaterThan(trapIndex);
    });
  });

  describe("secretsFile (build-time secret shuttling)", () => {
    it("omits source/unset/env-pass when secretsFile is undefined", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).not.toContain("secrets.env");
      expect(out).not.toContain("unset NPM_TOKEN");
      expect(out).not.toContain("unset BUF_TOKEN");
      expect(out).not.toContain("--env-pass");
    });

    it("sources secrets on the host, forwards them only to setup, and clears them before the agent", () => {
      const out = buildLaunchCommand(arguments_({ secretsFile: "/tmp/prompt-team-1/secrets.env" }));

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupWrapIndex = out.indexOf(
        "safehouse-clearance' --env-pass=NPM_TOKEN,BUF_TOKEN sh -c",
      );
      const setupIndex = out.indexOf("setup_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
      const agentIndex = out.indexOf(`exec claude "$@"`);

      // Secrets are sourced into the host shell before the wrap so Safehouse can
      // forward them into setup; the agent Safehouse process never gets them.
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(setupWrapIndex).toBeGreaterThan(sourceIndex);
      expect(out).toContain("--env-pass=NPM_TOKEN,BUF_TOKEN");
      expect(setupIndex).toBeGreaterThan(setupWrapIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(agentWrapIndex).toBeGreaterThan(unsetIndex);
      expect(agentIndex).toBeGreaterThan(agentWrapIndex);
      expect(out.slice(agentWrapIndex)).not.toContain("--env-pass");
      expect(out.slice(agentWrapIndex)).not.toContain("unset NPM_TOKEN");
      expect(out).toContain(
        "if [ -f '/tmp/prompt-team-1/secrets.env' ]; then set -a && . '/tmp/prompt-team-1/secrets.env' && set +a; fi",
      );
    });

    it("clears secrets on the host before the agent Safehouse invocation", () => {
      const out = buildLaunchCommand(arguments_({ secretsFile: "/tmp/prompt-team-1/secrets.env" }));

      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
      expect(unsetIndex).toBeGreaterThan(-1);
      expect(agentWrapIndex).toBeGreaterThan(unsetIndex);
      expect(out).toContain('sh "$_p"; _safehouse_status=$?');
    });
  });

  describe("runner='none'", () => {
    it("runs the agent directly without the safehouse wrapper", () => {
      const out = buildLaunchCommand(arguments_({ runner: "none" }));

      expect(out).not.toContain("safehouse-clearance");
      expect(out).not.toContain("--enable=all-agents");
      // No `exec` — the launch wrapper drops it so the EXIT trap can fire.
      expect(out).not.toMatch(/(?:^|[\s&;])exec claude/);
      expect(out).toMatch(/claude "\$_p"$/);
    });

    it("sources and clears build secrets on the host (no sandbox to forward into)", () => {
      const out = buildLaunchCommand(
        arguments_({ runner: "none", secretsFile: "/tmp/prompt-team-1/secrets.env" }),
      );

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupIndex = out.indexOf("setup_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      // The unwrapped path drops `exec` so the EXIT trap can fire; the agent is
      // the final `&&`-chained command.
      const agentIndex = out.indexOf(`claude "$_p"`);
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(sourceIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(agentIndex).toBeGreaterThan(unsetIndex);
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

    it("wraps the agent in `sbx exec -it -w <worktree> <sandbox> sh -c <setup; exec agent>`", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).toContain("exec sbx exec -it -w '/work/repo-a-team-1' 'groundcrew-claude' sh -c");
      expect(out).toContain("exec claude");
      expect(out).toMatch(/sh "\$_p"$/);
      // sdx routes through `sbx exec`, not Safehouse, so the Safehouse-only
      // profile-selection flag must not leak onto this path.
      expect(out).not.toContain("--enable=all-agents");
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

      // The inner agent command is single-quoted for `sh -c`, so embedded
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

  // Step markers + the pipe-pane TUI-boundary close live on the unwrapped host
  // path only (safehouse/sdx exec into a wrapper/sandbox).
  describe("step markers (runner='none')", () => {
    const noneArguments = (
      overrides: Partial<Parameters<typeof buildLaunchCommand>[0]> = {},
    ): Parameters<typeof buildLaunchCommand>[0] => arguments_({ runner: "none", ...overrides });

    it("emits a step marker before each chained step (default config, no secrets)", () => {
      const out = buildLaunchCommand(noneArguments());

      expect(out).toContain(stepMarker("cd to worktree"));
      expect(out).toContain(stepMarker("run host setup"));
      expect(out).toContain(stepMarker("stage prompt"));
      expect(out).toContain(stepMarker("agent starting"));
    });

    it("emits source/unset step markers when secretsFile is set", () => {
      const out = buildLaunchCommand(noneArguments({ secretsFile: "/tmp/secrets.env" }));

      expect(out).toContain(stepMarker("source build secrets"));
      expect(out).toContain(stepMarker("unset build secrets"));
    });

    it("omits source/unset step markers when secretsFile is absent", () => {
      const out = buildLaunchCommand(noneArguments());

      expect(out).not.toContain("source build secrets");
      expect(out).not.toContain("unset build secrets");
    });

    it("places step markers in chain order (cd → setup → stage → agent)", () => {
      const out = buildLaunchCommand(noneArguments());

      const cdIdx = out.indexOf(stepMarker("cd to worktree"));
      const setupIdx = out.indexOf(stepMarker("run host setup"));
      const stageIdx = out.indexOf(stepMarker("stage prompt"));
      const agentIdx = out.indexOf(stepMarker("agent starting"));

      expect(cdIdx).toBeGreaterThan(-1);
      expect(setupIdx).toBeGreaterThan(cdIdx);
      expect(stageIdx).toBeGreaterThan(setupIdx);
      expect(agentIdx).toBeGreaterThan(stageIdx);
    });

    it("places the pipe-pane disable + `agent starting` marker before the agent command (TUI boundary)", () => {
      const out = buildLaunchCommand(noneArguments());

      // The boundary line is: marker echo → pipe-pane disable → agent command.
      // The disable closes the capture pipe from inside the pane so the agent's
      // TUI output isn't logged. Regex pins the exact disable form to prevent
      // a regression that re-enables capture (e.g., removes the disable, or
      // accidentally chains another command in front of the agent).
      expect(out).toMatch(
        /agent starting' >&2 && \(tmux pipe-pane -t "\$TMUX_PANE" \|\| true\) && [^&;|\n]*"\$_p"$/,
      );
    });

    it("disables pipe-pane from inside the pane right before the agent runs", () => {
      const out = buildLaunchCommand(noneArguments());

      expect(out).toContain(`(tmux pipe-pane -t "$TMUX_PANE" || true)`);

      // Order: agent-starting marker → pipe-pane disable → agent command.
      const markerIdx = out.indexOf("agent starting");
      const disableIdx = out.indexOf("tmux pipe-pane");
      const agentIdx = out.lastIndexOf(`claude "$_p"`);
      expect(markerIdx).toBeGreaterThan(-1);
      expect(disableIdx).toBeGreaterThan(markerIdx);
      expect(agentIdx).toBeGreaterThan(disableIdx);
    });
  });
});
