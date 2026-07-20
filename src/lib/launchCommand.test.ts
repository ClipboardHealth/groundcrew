import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUILD_SECRET_NAMES, type AgentDefinition } from "./config.ts";
import {
  buildLaunchCommand,
  resolveSafehouseClearancePath,
  withResumeArgs,
} from "./launchCommand.ts";

const WORKER_ENVIRONMENT = {
  GROUNDCREW_TASK_ID: "todo:gc-1",
  GROUNDCREW_COMPLETE: "crew task done todo:gc-1",
} as const;

function arguments_(
  overrides: Partial<Parameters<typeof buildLaunchCommand>[0]> = {},
): Parameters<typeof buildLaunchCommand>[0] {
  const worktreeDir = overrides.worktreeDir ?? "/work/repo-a-team-1";
  return {
    definition: { cmd: "claude", color: "#fff" } satisfies AgentDefinition,
    promptFile: "/tmp/prompt-team-1/prompt.txt",
    worktreeDir,
    workingDir: worktreeDir,
    runner: "safehouse",
    networkEgress: "allowlisted",
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
  it("runs prepareWorktree under plain Safehouse, then runs only the agent through the profile shim", () => {
    const out = buildLaunchCommand(arguments_({ prepareWorktreeCommand: "npm ci" }));

    const setupWrapIndex = out.indexOf("safehouse-clearance' sh -c");
    const setupIndex = out.indexOf("npm ci");
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
    expect(out).toContain("npm ci");
    expect(out).toContain(`exec claude "$@"`);
    expect(out).toContain('sh "$_p"; _safehouse_status=$?');
    expect(setupWrapIndex).toBeGreaterThan(-1);
    expect(setupIndex).toBeGreaterThan(setupWrapIndex);
    expect(shimIndex).toBeGreaterThan(setupIndex);
    expect(agentWrapIndex).toBeGreaterThan(shimIndex);
    expect(agentIndex).toBeGreaterThan(agentWrapIndex);
    expect(out.slice(agentWrapIndex)).not.toContain("npm ci");
  });

  it("skips the prepareWorktree phase when no hook command is configured", () => {
    const out = buildLaunchCommand(arguments_());

    expect(out).not.toContain("groundcrew prepareWorktree hook exited");
    expect(out).not.toContain("safehouse-clearance' sh -c");
    expect(out).not.toContain(".groundcrew/setup.sh");
    expect(out).toContain('"$_safehouse_shim" -c');
  });

  it("grants the worktree root and git common dir to both safehouse wraps via --add-dirs", () => {
    const out = buildLaunchCommand(
      arguments_({
        prepareWorktreeCommand: "npm ci",
        safehouseAddDirs: ["/work/repo-a-team-1", "/src/carrot/.git"],
      }),
    );

    const addDirsFlag = "--add-dirs='/work/repo-a-team-1:/src/carrot/.git'";
    // One grant per wrap: the prepareWorktree wrap (so the hook's git/npm can
    // reach the checkout) and the agent wrap (so git works inside a graft /
    // sparse-checkout worktree whose real `.git` lives outside the worktree
    // tree — e.g. an external `~/carrot/.git`).
    expect(out.split(addDirsFlag).length - 1).toBe(2);
    expect(out).toContain(`${addDirsFlag} sh -c`);
    expect(out).toContain(`${addDirsFlag} "$_safehouse_shim" -c`);
  });

  it("forwards worker completion env into the Safehouse agent wrap only", () => {
    const out = buildLaunchCommand(
      arguments_({
        prepareWorktreeCommand: "npm ci",
        workerEnvironment: WORKER_ENVIRONMENT,
      }),
    );

    const setupWrapIndex = out.indexOf("safehouse-clearance' sh -c");
    const setupIndex = out.indexOf("npm ci");
    const exportIndex = out.indexOf("export GROUNDCREW_TASK_ID='todo:gc-1'");
    const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
    expect(exportIndex).toBeGreaterThan(setupIndex);
    expect(exportIndex).toBeLessThan(agentWrapIndex);
    expect(out).toContain("export GROUNDCREW_COMPLETE='crew task done todo:gc-1'");
    expect(out.slice(setupWrapIndex, setupIndex)).not.toContain("GROUNDCREW_COMPLETE");
    expect(out.slice(agentWrapIndex - 100, agentWrapIndex)).toContain(
      "--env-pass=GROUNDCREW_TASK_ID,GROUNDCREW_COMPLETE ",
    );
  });

  it("omits --add-dirs when no extra filesystem grants are requested", () => {
    const out = buildLaunchCommand(arguments_({ prepareWorktreeCommand: "npm ci" }));

    expect(out).not.toContain("--add-dirs");
  });

  it("turns on requested Safehouse features on the agent wrap only via --enable", () => {
    const out = buildLaunchCommand(
      arguments_({
        prepareWorktreeCommand: "npm ci",
        safehouseEnableFeatures: ["browser-native-messaging", "agent-browser"],
      }),
    );

    const enableFlag = "--enable='browser-native-messaging,agent-browser'";
    // The shim-dir line splits the prepareWorktree wrap (before) from the agent
    // wrap (after); browser features belong only to the latter.
    const agentWrapStart = out.indexOf("_safehouse_shim_dir=$(mktemp");

    expect(out.split(enableFlag).length - 1).toBe(1);
    expect(out).toContain(`${enableFlag} "$_safehouse_shim" -c`);
    expect(out.slice(0, agentWrapStart)).not.toContain("--enable");
  });

  it("omits --enable when no Safehouse features are requested", () => {
    const out = buildLaunchCommand(arguments_({ prepareWorktreeCommand: "npm ci" }));

    expect(out).not.toContain("--enable");
  });

  it("uses an agent-named shell shim so Safehouse applies only the matching agent profile", () => {
    const out = buildLaunchCommand(arguments_());

    expect(out).toContain('_safehouse_shim_dir=$(mktemp -d "');
    expect(out).toContain('/groundcrew-safehouse-XXXXXX")');
    // Combined EXIT trap covers both the shim dir (introduced by main's #128
    // two-wrap design) and promptDir (introduced by this branch's preLaunch
    // failure-cleanup work). promptDir is wiped explicitly before the agent
    // wrap, so its inclusion here is defensive — keeps a single trap covering
    // every failure window between shim creation and the post-wrap cleanup.
    expect(out).toContain(
      String.raw`trap 'rm -rf "$_safehouse_shim_dir"; rm -rf '\''/tmp/prompt-team-1'\''' EXIT`,
    );
    expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(out).toContain('ln -s /bin/sh "$_safehouse_shim"');
    expect(out).toContain('"$_safehouse_shim" -c');
    expect(out).not.toContain("--enable=all-agents");
  });

  it("grants safehouseAgentAddDirsReadOnly to the agent wrap only, via --add-dirs-ro", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "claude --permission-mode auto", color: "#fff" },
        prepareWorktreeCommand: "npm ci",
        safehouseAgentAddDirsReadOnly: ["/Users/dev/.config/tfenv"],
      }),
    );

    expect(out).toContain("--add-dirs-ro='/Users/dev/.config/tfenv'");
    const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
    const readOnlyGrantIndex = out.indexOf("--add-dirs-ro='/Users/dev/.config/tfenv'");
    expect(readOnlyGrantIndex).toBeLessThan(agentWrapIndex);
    const prepareWrap = out.slice(0, out.indexOf("_safehouse_shim_dir="));
    expect(prepareWrap).not.toContain("--add-dirs-ro");
  });

  it("merges safehouseAgentAddDirsReadOnly with the cmux integration read-only grant", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "claude --permission-mode auto", color: "#fff" },
        safehouseAgentIntegration: {
          addDirsReadOnly: ["/Applications/cmux.app"],
          envPass: [],
          commandPreludes: [],
        },
        safehouseAgentAddDirsReadOnly: ["/Users/dev/.config/tfenv"],
      }),
    );

    expect(out).toContain("--add-dirs-ro='/Applications/cmux.app:/Users/dev/.config/tfenv'");
  });

  it("can grant a workspace shim integration to the Safehouse agent without stripping PATH", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "claude --permission-mode auto", color: "#fff" },
        prepareWorktreeCommand: "npm ci",
        safehouseAgentIntegration: {
          addDirsReadOnly: ["/Applications/cmux.app", "/Users/dev/.local/state/cmux"],
          envPass: [
            "CMUX_SURFACE_ID",
            "CMUX_SOCKET_PATH",
            "CMUX_CLAUDE_WRAPPER_SHIM",
            "CMUX_CLAUDE_WRAPPER_SHIM_ROOT",
            "CMUX_CUSTOM_CLAUDE_PATH",
          ],
          commandPreludes: ["export CMUX_CUSTOM_CLAUDE_PATH=/Users/dev/.local/bin/claude"],
        },
      }),
    );

    const prepareWrapIndex = out.indexOf("safehouse-clearance' sh -c");
    const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
    const readOnlyGrantIndex = out.indexOf(
      "--add-dirs-ro='/Applications/cmux.app:/Users/dev/.local/state/cmux'",
    );
    const envPassIndex = out.indexOf(
      "--env-pass=CMUX_SURFACE_ID,CMUX_SOCKET_PATH,CMUX_CLAUDE_WRAPPER_SHIM,CMUX_CLAUDE_WRAPPER_SHIM_ROOT,CMUX_CUSTOM_CLAUDE_PATH",
    );
    const shimSetupIndex = out.indexOf("_safehouse_shim_dir=", prepareWrapIndex);
    const preludeIndex = out.indexOf("export CMUX_CUSTOM_CLAUDE_PATH=/Users/dev/.local/bin/claude");
    const execIndex = out.indexOf('exec claude --permission-mode auto "$@"');
    expect(prepareWrapIndex).toBeGreaterThan(-1);
    expect(readOnlyGrantIndex).toBeGreaterThan(prepareWrapIndex);
    expect(readOnlyGrantIndex).toBeLessThan(agentWrapIndex);
    expect(envPassIndex).toBeGreaterThan(prepareWrapIndex);
    expect(envPassIndex).toBeLessThan(agentWrapIndex);
    expect(preludeIndex).toBeGreaterThan(agentWrapIndex);
    expect(execIndex).toBeGreaterThan(preludeIndex);
    expect(shimSetupIndex).toBeGreaterThan(prepareWrapIndex);
    const prepareWrap = out.slice(prepareWrapIndex, shimSetupIndex);
    expect(prepareWrap).not.toContain("--add-dirs-ro");
    expect(prepareWrap).not.toContain("CMUX_SURFACE_ID");
    expect(prepareWrap).not.toContain("CMUX_SOCKET_PATH");
    expect(out).not.toContain("_groundcrew_path_without_cmux");
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
    ).toThrow(/Cannot infer the agent command/);

    expect(() =>
      buildLaunchCommand(
        arguments_({
          definition: { cmd: "   ", color: "#fff" },
        }),
      ),
    ).toThrow(/Cannot infer the agent command/);
  });

  it("rejects unsafe inferred Safehouse profile command names", () => {
    expect(() =>
      buildLaunchCommand(
        arguments_({
          definition: { cmd: String.raw`claude\ code --permission-mode auto`, color: "#fff" },
        }),
      ),
    ).toThrow(/Cannot use "claude code" as an agent command name/);
  });

  it("does not double-wrap when cmd already starts with safehouse", () => {
    const out = buildLaunchCommand(
      arguments_({
        definition: { cmd: "safehouse claude", color: "#fff" },
      }),
    );

    expect(out).toMatch(/exec safehouse claude "\$_p"$/);
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

  it("includes a non-zero prepareWorktree status warning", () => {
    const out = buildLaunchCommand(arguments_({ prepareWorktreeCommand: "npm ci" }));

    expect(out).toContain("prepare_status=$?");
    expect(out).toContain("groundcrew prepareWorktree hook exited with status $prepare_status");
  });

  it("keeps prepareWorktree failures advisory even when the hook enables set -e", () => {
    const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-prepare-advisory-"));
    const promptFile = path.join(promptDir, "prompt.txt");
    const worktreeDir = mkdtempSync(path.join(tmpdir(), "groundcrew-prepare-advisory-wt-"));
    try {
      writeFileSync(promptFile, "the prompt body\n");

      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          promptFile,
          worktreeDir,
          prepareWorktreeCommand: "set -e; false",
          definition: { cmd: "true", color: "#fff" },
        }),
      );

      const result = spawnSync("sh", ["-c", out], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "groundcrew prepareWorktree hook exited with status 1; continuing to agent.",
      );
      expect(() => statSync(promptDir)).toThrow(/ENOENT/);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  describe("secretsFile (build-time secret shuttling)", () => {
    it("omits source/unset/env-pass when secretsFile is undefined", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).not.toContain("secrets.env");
      expect(out).not.toContain("unset NPM_TOKEN");
      expect(out).not.toContain("unset BUF_TOKEN");
      expect(out).not.toContain("--env-pass");
    });

    it("sources secrets on the host, forwards them only to prepareWorktree, and clears them before the agent", () => {
      const out = buildLaunchCommand(
        arguments_({
          secretsFile: "/tmp/prompt-team-1/secrets.env",
          prepareWorktreeCommand: "npm ci",
        }),
      );

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupWrapIndex = out.indexOf(
        "safehouse-clearance' --env-pass=NPM_TOKEN,BUF_TOKEN sh -c",
      );
      const setupIndex = out.indexOf("prepare_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
      const agentIndex = out.indexOf(`exec claude "$@"`);

      // Secrets are sourced into the host shell before the wrap so Safehouse can
      // forward them into prepareWorktree; the agent Safehouse process never gets them.
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

  describe("prepareWorktreeUnsandboxed (runner=safehouse)", () => {
    it("runs prepareWorktreeUnsandboxed on the host before the sandboxed prepareWorktree wrap", () => {
      const out = buildLaunchCommand(
        arguments_({
          prepareWorktreeUnsandboxedCommand: "bin/setup",
          prepareWorktreeCommand: "npm ci",
        }),
      );

      const unsandboxedIndex = out.indexOf("(bin/setup); prepare_status=$?");
      const sandboxedWrapIndex = out.indexOf("safehouse-clearance' sh -c");
      const npmIndex = out.indexOf("npm ci");
      const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');

      // The unsandboxed host command runs first, and is NOT inside a safehouse wrap.
      expect(unsandboxedIndex).toBeGreaterThan(-1);
      expect(unsandboxedIndex).toBeLessThan(sandboxedWrapIndex);
      // prepareWorktree still runs inside the safehouse prepare wrap.
      expect(sandboxedWrapIndex).toBeGreaterThan(-1);
      expect(npmIndex).toBeGreaterThan(sandboxedWrapIndex);
      expect(agentWrapIndex).toBeGreaterThan(npmIndex);
      // bin/setup is on the host, not wrapped by safehouse-clearance.
      expect(out).not.toContain("safehouse-clearance' sh -c '(bin/setup)");
    });

    it("runs prepareWorktreeUnsandboxed on the host even when no sandboxed prepareWorktree is set", () => {
      const out = buildLaunchCommand(
        arguments_({ prepareWorktreeUnsandboxedCommand: "bin/setup" }),
      );

      expect(out).toContain("(bin/setup); prepare_status=$?");
      // No sandboxed prepare wrap when prepareWorktree is unset.
      expect(out).not.toContain("safehouse-clearance' sh -c");
      // The agent wrap still runs.
      expect(out).toContain('"$_safehouse_shim" -c');
    });
  });

  describe("runner='none'", () => {
    it("execs the agent directly without the safehouse wrapper", () => {
      const out = buildLaunchCommand(arguments_({ runner: "none" }));

      expect(out).not.toContain("safehouse-clearance");
      expect(out).not.toContain("--enable=all-agents");
      expect(out).toMatch(/exec claude "\$_p"$/);
    });

    it("exports worker completion env before executing the agent", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          workerEnvironment: WORKER_ENVIRONMENT,
        }),
      );

      const exportIndex = out.indexOf("export GROUNDCREW_TASK_ID='todo:gc-1'");
      const execIndex = out.indexOf('exec claude "$_p"');
      expect(exportIndex).toBeGreaterThan(-1);
      expect(exportIndex).toBeLessThan(execIndex);
      expect(out).toContain("export GROUNDCREW_COMPLETE='crew task done todo:gc-1'");
    });

    it("cds into workingDir while {{worktree}} still expands to the worktree root", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: { cmd: "agent --root {{worktree}}", color: "#fff" },
          worktreeDir: "/work/repo-a-team-1",
          workingDir: "/work/repo-a-team-1/services/api",
          runner: "none",
        }),
      );

      // cwd is the subproject…
      expect(out).toContain("cd '/work/repo-a-team-1/services/api'");
      // …but {{worktree}} substitution stays the checkout root.
      expect(out).toContain("--root '/work/repo-a-team-1'");
      expect(out).not.toContain("cd '/work/repo-a-team-1' &&");
    });

    it("sources and clears build secrets on the host (no sandbox to forward into)", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          secretsFile: "/tmp/prompt-team-1/secrets.env",
          prepareWorktreeCommand: "npm ci",
        }),
      );

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupIndex = out.indexOf("prepare_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const execIndex = out.indexOf(`exec claude "$_p"`);
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(sourceIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(execIndex).toBeGreaterThan(unsetIndex);
      expect(out).not.toContain("--env-pass");
    });

    it("runs prepareWorktreeUnsandboxed on the host before prepareWorktree", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          prepareWorktreeUnsandboxedCommand: "bin/setup",
          prepareWorktreeCommand: "npm ci",
        }),
      );

      const unsandboxedIndex = out.indexOf("bin/setup");
      const prepareIndex = out.indexOf("npm ci");
      const agentIndex = out.indexOf("exec claude");
      expect(unsandboxedIndex).toBeGreaterThan(-1);
      expect(prepareIndex).toBeGreaterThan(unsandboxedIndex);
      expect(agentIndex).toBeGreaterThan(prepareIndex);
      // Both run with status reporting so a failure is surfaced, not swallowed.
      expect(out).toContain("(bin/setup); prepare_status=$?");
    });

    it("does not launch the agent when a prerequisite before prepareWorktreeUnsandboxed fails", () => {
      const markerDir = mkdtempSync(path.join(tmpdir(), "groundcrew-host-hook-marker-"));
      const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-host-hook-prompt-"));
      const promptFile = path.join(promptDir, "prompt.txt");
      const agentMarker = path.join(markerDir, "agent-ran");
      const missingWorktreeDir = path.join(markerDir, "missing-worktree");
      try {
        writeFileSync(promptFile, "the prompt body\n");
        const out = buildLaunchCommand(
          arguments_({
            runner: "none",
            promptFile,
            worktreeDir: missingWorktreeDir,
            prepareWorktreeUnsandboxedCommand: "true",
            definition: { cmd: `touch '${agentMarker}'`, color: "#fff" },
            omitPromptArgument: true,
          }),
        );

        const result = spawnSync("sh", ["-c", out]);

        expect(result.status).not.toBe(0);
        expect(() => statSync(agentMarker)).toThrow(/ENOENT/);
      } finally {
        rmSync(markerDir, { recursive: true, force: true });
        rmSync(promptDir, { recursive: true, force: true });
      }
    });

    it("scrubs preLaunchEnv names inside the prepareWorktreeUnsandboxed subshell", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          definition: { cmd: "claude", color: "#fff", preLaunchEnv: ["TOKEN"] },
          prepareWorktreeUnsandboxedCommand: "bin/setup",
        }),
      );

      expect(out).toContain("(unset TOKEN; bin/setup); prepare_status=$?");
    });
  });

  describe("EXIT-trap promptDir cleanup", () => {
    it("arms the `trap 'rm -rf <promptDir>' EXIT` before `cd` so a failed `cd` still wipes promptDir", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).toContain(String.raw`trap 'rm -rf '\''/tmp/prompt-team-1'\''' EXIT`);
      const trapIndex = out.indexOf("trap 'rm -rf");
      const cdIndex = out.indexOf("cd '/work/repo-a-team-1'");
      const setupIndex = out.indexOf('"$_safehouse_shim" -c');
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
      const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-trap-cleanup-"));
      const promptFile = path.join(promptDir, "prompt.txt");
      const secretsFile = path.join(promptDir, "secrets.env");
      const worktreeDir = mkdtempSync(path.join(tmpdir(), "groundcrew-trap-worktree-"));
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
      const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-trap-safehouse-"));
      const promptFile = path.join(promptDir, "prompt.txt");
      const worktreeDir = mkdtempSync(path.join(tmpdir(), "groundcrew-trap-safehouse-wt-"));
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

    it("wipes promptDir under the safehouse runner when preLaunch returns non-zero", () => {
      const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-trap-safehouse-status-"));
      const promptFile = path.join(promptDir, "prompt.txt");
      const secretsFile = path.join(promptDir, "secrets.env");
      const worktreeDir = mkdtempSync(path.join(tmpdir(), "groundcrew-trap-safehouse-status-wt-"));
      try {
        writeFileSync(promptFile, "the prompt body\n");
        writeFileSync(secretsFile, "NPM_TOKEN='leaked'\n");

        const out = buildLaunchCommand(
          arguments_({
            runner: "safehouse",
            promptFile,
            worktreeDir,
            secretsFile,
            definition: {
              cmd: "echo never-reached",
              color: "#fff",
              preLaunch: "SESSION_TOKEN=$(false) && export SESSION_TOKEN",
            },
          }),
        );

        const result = spawnSync("sh", ["-c", out]);
        expect(result.status).toBe(1);
        expect(() => statSync(promptDir)).toThrow(/ENOENT/);
      } finally {
        rmSync(promptDir, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  });

  describe("preLaunch", () => {
    const baseline = buildLaunchCommand(arguments_());

    it("is deterministic when preLaunch is undefined (same launch string across calls)", () => {
      const out = buildLaunchCommand(arguments_());

      expect(out).toBe(baseline);
    });

    it("runs preLaunch on the host before sourcing build secrets so the minting snippet never sees NPM_TOKEN / BUF_TOKEN (safehouse)", () => {
      const out = buildLaunchCommand(
        arguments_({
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunch: "export FOO=bar",
          },
          secretsFile: "/tmp/prompt-team-1/secrets.env",
          prepareWorktreeCommand: "npm ci",
        }),
      );

      const cdIndex = out.indexOf("cd '/work/repo-a-team-1'");
      const preLaunchIndex = out.indexOf("export FOO=bar");
      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const readPromptIndex = out.indexOf("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
      const setupWrapIndex = out.indexOf("safehouse-clearance");
      // Two `unset NPM_TOKEN BUF_TOKEN` occurrences now: the first scrubs the
      // inherited env before preLaunch, the last clears the file-sourced
      // values between the prepareWorktree and agent wraps.
      const scrubUnsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const betweenWrapsUnsetIndex = out.lastIndexOf("unset NPM_TOKEN BUF_TOKEN");
      const agentWrapIndex = out.indexOf('"$_safehouse_shim" -c');
      // trap → cd → unset (scrub inherited) → preLaunch → source secrets.env →
      //   read prompt → prepareWorktree wrap → host-side unset → agent wrap. The scrub
      // runs before preLaunch so it sees neither inherited nor sourced build
      // secrets; the between-wraps unset keeps them off the agent wrap (#128).
      expect(cdIndex).toBeGreaterThan(-1);
      expect(scrubUnsetIndex).toBeGreaterThan(cdIndex);
      expect(preLaunchIndex).toBeGreaterThan(scrubUnsetIndex);
      expect(sourceIndex).toBeGreaterThan(preLaunchIndex);
      expect(readPromptIndex).toBeGreaterThan(sourceIndex);
      expect(setupWrapIndex).toBeGreaterThan(readPromptIndex);
      expect(betweenWrapsUnsetIndex).toBeGreaterThan(setupWrapIndex);
      expect(agentWrapIndex).toBeGreaterThan(betweenWrapsUnsetIndex);
      // No build-secret *values* are sourced into env before preLaunch runs.
      expect(out.slice(0, preLaunchIndex)).not.toContain(". '/tmp/prompt-team-1/secrets.env'");
    });

    it("scrubs build secrets inherited from the launching env so preLaunch cannot read NPM_TOKEN / BUF_TOKEN (safehouse)", () => {
      // stageBuildSecrets copies build secrets out of groundcrew's own
      // process env, which the launch shell inherits. Sourcing secrets.env
      // after preLaunch is not enough on its own — the inherited values are
      // already in env. Simulate that here by seeding NPM_TOKEN / BUF_TOKEN in
      // the spawn env. preLaunch always aborts before the real wrapper and
      // encodes leak (11) vs clean (22) in its exit code.
      const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-inherit-"));
      const promptFile = path.join(promptDir, "prompt.txt");
      const secretsFile = path.join(promptDir, "secrets.env");
      const worktreeDir = mkdtempSync(path.join(tmpdir(), "groundcrew-inherit-wt-"));
      try {
        writeFileSync(promptFile, "the prompt body\n");
        writeFileSync(secretsFile, "NPM_TOKEN='from-file'\nBUF_TOKEN='from-file'\n");

        const out = buildLaunchCommand(
          arguments_({
            runner: "safehouse",
            promptFile,
            worktreeDir,
            secretsFile,
            definition: {
              cmd: "echo never-reached",
              color: "#fff",
              // Aborts before the real wrapper (and any external command), so
              // only shell builtins run: leak -> exit 11, clean -> exit 22.
              preLaunch: 'if [ -n "$NPM_TOKEN" ] || [ -n "$BUF_TOKEN" ]; then exit 11; fi; exit 22',
            },
          }),
        );

        const result = spawnSync("sh", ["-c", out], {
          // Seed the build secrets in the spawn env to simulate the launch
          // shell inheriting them from groundcrew. A fixed PATH avoids
          // depending on the parent env (and the lint ban on `process.env`).
          env: {
            PATH: "/usr/bin:/bin",
            NPM_TOKEN: "inherited-secret",
            BUF_TOKEN: "inherited-secret",
          },
        });
        expect(result.status).toBe(22);
      } finally {
        rmSync(promptDir, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    });

    it("scrubs listed preLaunchEnv names before preLaunch so stale ambient values are not forwarded", () => {
      const promptDir = mkdtempSync(path.join(tmpdir(), "groundcrew-prelaunch-pass-scrub-"));
      const promptFile = path.join(promptDir, "prompt.txt");
      const worktreeDir = mkdtempSync(path.join(tmpdir(), "groundcrew-prelaunch-pass-scrub-wt-"));
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
              preLaunch: `[ -z "\${SESSION_TOKEN-}" ] || exit 41; exit 42`,
              preLaunchEnv: ["SESSION_TOKEN"],
            },
          }),
        );

        const scrubIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN SESSION_TOKEN");
        const preLaunchIndex = out.indexOf(`[ -z "\${SESSION_TOKEN-}" ]`);
        const agentEnvPassIndex = out.indexOf("--env-pass=SESSION_TOKEN");
        expect(scrubIndex).toBeGreaterThan(-1);
        expect(preLaunchIndex).toBeGreaterThan(scrubIndex);
        expect(agentEnvPassIndex).toBeGreaterThan(preLaunchIndex);

        const actual = spawnSync("sh", ["-c", out], {
          env: { PATH: "/bin:/usr/bin", SESSION_TOKEN: "stale-token" },
        });
        expect(actual.status).toBe(42);
        expect(() => statSync(promptDir)).toThrow(/ENOENT/);
      } finally {
        rmSync(promptDir, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
      }
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

    it("runs preLaunch after build-secret unset on the unwrapped host path (runner='none' + secretsFile)", () => {
      const out = buildLaunchCommand(
        arguments_({
          runner: "none",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunch: "export FOO=bar",
          },
          secretsFile: "/tmp/prompt-team-1/secrets.env",
          prepareWorktreeCommand: "npm ci",
        }),
      );

      const sourceIndex = out.indexOf(". '/tmp/prompt-team-1/secrets.env'");
      const setupIndex = out.indexOf("prepare_status=$?");
      const unsetIndex = out.indexOf("unset NPM_TOKEN BUF_TOKEN");
      const preLaunchIndex = out.indexOf("export FOO=bar");
      const execIndex = out.indexOf(`exec claude "$_p"`);
      // Unwrapped host path: source → prepareWorktree → unset → preLaunch → exec.
      // Same "preLaunch sees a clean env" contract as the safehouse path,
      // just enforced via an explicit `unset` instead of source-after-mint.
      expect(sourceIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(sourceIndex);
      expect(unsetIndex).toBeGreaterThan(setupIndex);
      expect(preLaunchIndex).toBeGreaterThan(unsetIndex);
      expect(execIndex).toBeGreaterThan(preLaunchIndex);
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
    it("splits --env-pass per wrap: build secrets to prepareWorktree, preLaunchEnv to agent (PR #128 isolation)", () => {
      const out = buildLaunchCommand(
        arguments_({
          secretsFile: "/tmp/prompt-team-1/secrets.env",
          prepareWorktreeCommand: "npm ci",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunchEnv: ["SESSION_TOKEN", "TEAM_ID"],
          },
        }),
      );

      const setupWrapRe = /safehouse-clearance' (?<envPass>--env-pass=[^ ]+ )?sh -c '[^']*'/;
      const agentWrapRe = /safehouse-clearance' (?<envPass>--env-pass=[^ ]+ )?"\$_safehouse_shim"/;
      const setupWrapMatch = setupWrapRe.exec(out);
      const agentWrapMatch = agentWrapRe.exec(out);
      // prepareWorktree wrap: build secrets only — preLaunch credentials must never reach
      // the profile-neutral prepare phase that #128 deliberately walled off.
      expect(setupWrapMatch?.[1]).toBe(`--env-pass=${BUILD_SECRET_NAMES.join(",")} `);
      // Agent wrap: preLaunchEnv only — build secrets are `unset` on the host
      // between the two wraps, so forwarding them here would silently no-op.
      expect(agentWrapMatch?.[1]).toBe("--env-pass=SESSION_TOKEN,TEAM_ID ");
      // The old single-wrap composition must NOT reappear anywhere.
      expect(out).not.toContain(`--env-pass=${BUILD_SECRET_NAMES.join(",")},SESSION_TOKEN`);
    });

    it("emits an agent-wrap --env-pass when no secretsFile is staged (prepareWorktree wrap unflagged)", () => {
      const out = buildLaunchCommand(
        arguments_({
          prepareWorktreeCommand: "npm ci",
          definition: {
            cmd: "claude",
            color: "#fff",
            preLaunchEnv: ["SESSION_TOKEN"],
          },
        }),
      );

      const setupWrapRe = /safehouse-clearance' (?<envPass>--env-pass=[^ ]+ )?sh -c '[^']*'/;
      const agentWrapRe = /safehouse-clearance' (?<envPass>--env-pass=[^ ]+ )?"\$_safehouse_shim"/;
      const setupWrapMatch = setupWrapRe.exec(out);
      const agentWrapMatch = agentWrapRe.exec(out);
      expect(setupWrapMatch?.[1]).toBeUndefined();
      expect(agentWrapMatch?.[1]).toBe("--env-pass=SESSION_TOKEN ");
      // No build-secret names should sneak in (no secretsFile staged).
      for (const name of BUILD_SECRET_NAMES) {
        expect(out).not.toContain(name);
      }
    });

    it("omits --env-pass on both wraps when preLaunchEnv is an empty array and there is no secretsFile", () => {
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

    it("treats preLaunchEnv: [] as a no-op under sdx (no throw, no --env-pass)", () => {
      // Empty list forwards zero names → unsupported-runner guard must not
      // fire. Locks the "empty is a uniform no-op in every runner" contract
      // at the launch-command boundary as well as the prepare boundary.
      const out = buildLaunchCommand(
        arguments_({
          runner: "sdx",
          sandboxName: "groundcrew-repo-a-claude",
          definition: {
            cmd: "claude",
            color: "#fff",
            sandbox: { agent: "claude" },
            preLaunchEnv: [],
          },
        }),
      );

      expect(out).toContain("exec sbx exec -it");
      expect(out).not.toContain("--env-pass");
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

    it("throws when workerEnvironment is set with a cmd that already starts with safehouse", () => {
      expect(() =>
        buildLaunchCommand(
          arguments_({
            definition: {
              cmd: "safehouse --env-pass=OTHER my-agent",
              color: "#fff",
            },
            workerEnvironment: WORKER_ENVIRONMENT,
          }),
        ),
      ).toThrow(/workerEnvironment cannot be injected when `cmd` starts with `safehouse`/);
    });

    it("treats preLaunchEnv: [] as a no-op when cmd already starts with safehouse", () => {
      // Same contract on the safehouse-prefixed-cmd path: an empty list has
      // nothing to inject, so the user-owns-the-wrap guard must not fire,
      // and groundcrew must not splice a second --env-pass onto a wrap it
      // does not own.
      const out = buildLaunchCommand(
        arguments_({
          definition: {
            cmd: "safehouse my-agent",
            color: "#fff",
            preLaunchEnv: [],
          },
        }),
      );

      expect(out).toMatch(/exec safehouse my-agent "\$_p"$/);
      expect(out).not.toContain("--env-pass");
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

    it("wraps the agent in `sbx exec -it -w <worktree> <sandbox> sh -c <exec agent>`", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).toContain("exec sbx exec -it -w '/work/repo-a-team-1' 'groundcrew-claude' sh -c");
      expect(out).toContain("exec claude");
      expect(out).toMatch(/sh "\$_p"$/);
      // sdx routes through `sbx exec`, not Safehouse, so the Safehouse-only
      // profile-selection flag must not leak onto this path.
      expect(out).not.toContain("--enable=all-agents");
    });

    it("skips prepareWorktree when no hook command is configured", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).not.toContain("groundcrew prepareWorktree hook exited");
      expect(out).not.toContain(".groundcrew/setup.sh");
    });

    it("runs the configured prepareWorktree command inside the sandbox", () => {
      const out = buildLaunchCommand(sdxArguments({ prepareWorktreeCommand: "npm ci" }));

      expect(out).toContain("npm ci");
      expect(out).toContain("groundcrew prepareWorktree hook exited with status $prepare_status");
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

    it("exports worker completion env inside the sandbox after prepareWorktree", () => {
      const out = buildLaunchCommand(
        sdxArguments({
          prepareWorktreeCommand: "npm ci",
          workerEnvironment: WORKER_ENVIRONMENT,
        }),
      );

      const prepareIndex = out.indexOf("npm ci");
      const exportIndex = out.indexOf("export GROUNDCREW_TASK_ID=");
      const agentIndex = out.indexOf("exec claude");
      expect(exportIndex).toBeGreaterThan(prepareIndex);
      expect(exportIndex).toBeLessThan(agentIndex);
      expect(out).toContain("export GROUNDCREW_COMPLETE=");
      expect(out).not.toContain("-e GROUNDCREW_TASK_ID");
      expect(out).not.toContain("-e GROUNDCREW_COMPLETE");
    });

    it("omits -e KEY flags when no secretsFile is staged", () => {
      const out = buildLaunchCommand(sdxArguments());

      expect(out).not.toContain("-e NPM_TOKEN");
      expect(out).not.toContain("-e BUF_TOKEN");
    });

    it("rejects unsandboxedHooks.prepareWorktree because the container has no host to run it on", () => {
      expect(() =>
        buildLaunchCommand(sdxArguments({ prepareWorktreeUnsandboxedCommand: "bin/setup" })),
      ).toThrow(/unsandboxedHooks\.prepareWorktree is not supported for runner='sdx'/);
    });
  });

  describe(`${buildLaunchCommand.name} (runner='safehouse', networkEgress='open')`, () => {
    it("wraps both safehouse phases with the bare safehouse binary, dropping the clearance shim and proxy env", () => {
      const out = buildLaunchCommand(
        arguments_({ networkEgress: "open", prepareWorktreeCommand: "npm ci" }),
      );

      // Bare safehouse for both the prepareWorktree wrap (`sh -c`) and the agent
      // wrap (the profile-selection shim), with no clearance layer.
      expect(out).toContain("safehouse sh -c");
      expect(out).toContain('safehouse "$_safehouse_shim" -c');
      expect(out).not.toContain("safehouse-clearance");
      expect(out).not.toContain("CLEARANCE_ALLOW_HOSTS_FILES");
    });

    it("keeps the filesystem sandbox machinery — profile shim and flag composition — intact", () => {
      const out = buildLaunchCommand(
        arguments_({
          networkEgress: "open",
          prepareWorktreeCommand: "npm ci",
          safehouseAddDirs: ["/work/repo-a-team-1", "/src/carrot/.git"],
          safehouseAgentAddDirs: ["/Users/dev/v"],
          definition: { cmd: "claude", color: "#fff", preLaunchEnv: ["SESSION_TOKEN"] },
        }),
      );

      // The agent-named symlink-to-/bin/sh profile-selection trick is unchanged.
      expect(out).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
      expect(out).toContain('ln -s /bin/sh "$_safehouse_shim"');
      // --add-dirs (both wraps), the agent-only --add-dirs grant, and --env-pass
      // all still compose around the bare-safehouse wrapper.
      expect(out).toContain("--add-dirs='/work/repo-a-team-1:/src/carrot/.git'");
      expect(out).toContain("--add-dirs='/work/repo-a-team-1:/src/carrot/.git:/Users/dev/v'");
      expect(out).toContain("--env-pass=SESSION_TOKEN ");
      expect(out).toContain(`exec claude "$@"`);
    });

    it("default allowlisted network egress still wraps with the clearance shim (regression)", () => {
      const out = buildLaunchCommand(arguments_({ prepareWorktreeCommand: "npm ci" }));

      expect(out).toContain("safehouse-clearance' sh -c");
      expect(out).toContain("CLEARANCE_ALLOW_HOSTS_FILES=");
      expect(out).not.toContain("safehouse sh -c");
    });
  });
});

describe("buildLaunchCommand omitPromptArgument (interactive launch)", () => {
  it("drops the trailing prompt positional on the unwrapped host path", () => {
    const withPrompt = buildLaunchCommand(arguments_({ runner: "none" }));
    const interactive = buildLaunchCommand(
      arguments_({ runner: "none", omitPromptArgument: true }),
    );

    expect(withPrompt).toMatch(/exec claude "\$_p"$/);
    expect(interactive).toMatch(/exec claude$/);
    // The prompt is still read into $_p (and its dir cleaned up); only the
    // positional is dropped.
    expect(interactive).toContain("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
  });

  it("drops the trailing prompt positional from the Safehouse agent wrap", () => {
    const withPrompt = buildLaunchCommand(arguments_({ runner: "safehouse" }));
    const interactive = buildLaunchCommand(
      arguments_({ runner: "safehouse", omitPromptArgument: true }),
    );

    expect(withPrompt).toContain(`sh "$_p"; _safehouse_status=$?`);
    expect(interactive).toContain(`sh; _safehouse_status=$?`);
    expect(interactive).not.toContain(`sh "$_p"`);
    expect(interactive).toContain("_p=$(cat '/tmp/prompt-team-1/prompt.txt')");
  });

  it("drops the trailing prompt positional from the sdx exec", () => {
    const sdxArgs = {
      runner: "sdx" as const,
      sandboxName: "groundcrew-claude",
      definition: {
        cmd: "claude",
        color: "#fff",
        sandbox: { agent: "claude" },
      } satisfies AgentDefinition,
    };
    const withPrompt = buildLaunchCommand(arguments_(sdxArgs));
    const interactive = buildLaunchCommand(arguments_({ ...sdxArgs, omitPromptArgument: true }));

    expect(withPrompt).toMatch(/sh "\$_p"$/);
    expect(interactive).toMatch(/ sh$/);
    expect(interactive).not.toContain(`sh "$_p"`);
  });
});

describe(withResumeArgs, () => {
  const definition = {
    cmd: "claude --permission-mode auto",
    color: "#fff",
  } satisfies AgentDefinition;

  it("appends the resume args after the base cmd", () => {
    const actual = withResumeArgs(definition, "--continue");

    expect(actual.cmd).toBe("claude --permission-mode auto --continue");
  });

  it("appends subcommand-style resume args verbatim", () => {
    const actual = withResumeArgs({ cmd: "codex --yolo", color: "#000" }, "resume --last");

    expect(actual.cmd).toBe("codex --yolo resume --last");
  });

  it("preserves the inferred command name (first token) and color", () => {
    const actual = withResumeArgs(definition, "--continue");

    expect(actual.cmd.startsWith("claude ")).toBe(true);
    expect(actual.color).toBe(definition.color);
  });

  it("does not mutate the input definition", () => {
    withResumeArgs(definition, "--continue");

    expect(definition.cmd).toBe("claude --permission-mode auto");
  });
});
