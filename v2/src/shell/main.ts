/**
 * Shell entry point: commander wiring, routing, rendering, and error → exit-code
 * mapping (design §9.3, contracts §7). The program is thin — each command action
 * loads the runtime context and delegates to a command module; the context join
 * and the module calls live elsewhere. Errors map to exit codes at this boundary:
 * `RepoNotOnDiskError` → 2, `NoTaskContextError` → 3, everything else → 1 with a
 * clean message (no stack unless `--verbose`).
 */
import { Command } from "@commander-js/extra-typings";

import { type Context, type ContextEnvironment, loadContext } from "./context.js";
import { exitCodeFor, messageFor } from "./errors.js";
import { type Io, processIo } from "./io.js";
import { packageVersion } from "./config/paths.js";
import { runArtifactAdd } from "./commands/artifactAdd.js";
import { runCleanup } from "./commands/cleanup.js";
import { runCompletions } from "./commands/completions.js";
import { runDoctor } from "./commands/doctor.js";
import { runDone } from "./commands/done.js";
import { runInit } from "./commands/init.js";
import { runPause } from "./commands/pause.js";
import { runRepoAdd } from "./commands/repoAdd.js";
import { runResume } from "./commands/resume.js";
import { runSourceDoctor, runSourceList } from "./commands/source.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runUpgrade } from "./commands/upgrade.js";

// oxlint-disable-next-line node/no-process-env -- the CLI's environment is the process environment (contracts §7)
const environment = process.env as ContextEnvironment;

/** Builds the `crew` program. `io` is injectable so tests can capture output. */
export function buildProgram(io: Io = processIo): Command {
  const program = new Command();

  program
    .name("crew")
    .description(
      "Dispatch task backlogs to sandboxed AI coding agents — one agent session per\n" +
        "task, over a workspace of worktrees.",
    )
    .version(packageVersion(), "-v, --version", "print version")
    .option("--verbose", "diagnostic output (env: GROUNDCREW_VERBOSE)")
    .showHelpAfterError();

  const verbose = (): boolean =>
    (program.opts() as { verbose?: boolean }).verbose === true ||
    truthyEnv(environment.GROUNDCREW_VERBOSE);

  const withContext = async (
    fn: (context: Context) => Promise<number | undefined>,
  ): Promise<void> => {
    try {
      const context = loadContext({ environment, cwd: process.cwd(), verbose: verbose() });
      const code = await fn(context);
      if (typeof code === "number") {
        process.exitCode = code;
      }
    } catch (error) {
      reportError({ error, io, verbose: verbose() });
    }
  };

  const plain = async (fn: () => Promise<number | undefined>): Promise<void> => {
    try {
      const code = await fn();
      if (typeof code === "number") {
        process.exitCode = code;
      }
    } catch (error) {
      reportError({ error, io, verbose: verbose() });
    }
  };

  program
    .command("start")
    .argument("[task]", "task id (canonical source:id, or unique prefix)")
    .description("poll sources and dispatch eligible tasks, or dispatch one task")
    .option("--watch", "poll continuously (without a task)")
    .option("--force", "dispatch even if blocked or at capacity (with a task)")
    .option("--agent <profile>", "override the task's routed agent profile")
    .option("--dry-run", "show the dispatch plan, dispatch nothing")
    .action(async (task, options) => {
      await withContext(async (context): Promise<undefined> => {
        await runStart({
          context,
          ...(task === undefined ? {} : { task }),
          options: {
            ...(options.watch === undefined ? {} : { watch: options.watch }),
            ...(options.force === undefined ? {} : { force: options.force }),
            ...(options.agent === undefined ? {} : { agent: options.agent }),
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          },
          io,
        });
      });
    });

  program
    .command("status")
    .argument("[task]", "task id or unique prefix")
    .description("queue, workspaces, sources — observed vs reported")
    .option("--json", "machine-readable output")
    .action(async (task, options) => {
      await withContext(async (context): Promise<undefined> => {
        await runStatus({
          context,
          ...(task === undefined ? {} : { task }),
          json: options.json === true,
          io,
        });
      });
    });

  program
    .command("pause")
    .argument("<task>", "task id or unique prefix")
    .description("suspend a running task, preserving its workspace")
    .action(async (task) => {
      await withContext(async (context): Promise<undefined> => {
        await runPause({ context, task, io });
      });
    });

  program
    .command("resume")
    .argument("<task>", "task id or unique prefix")
    .description("reopen a paused task's agent conversation")
    .option("--fresh", "start a new conversation instead of resuming")
    .action(async (task, options) => {
      await withContext(async (context): Promise<undefined> => {
        await runResume({ context, task, fresh: options.fresh === true, io });
      });
    });

  program
    .command("cleanup")
    .argument("[task]", "task id or unique prefix (omit with --all)")
    .description("tear down workspaces")
    .option("--all", "every idle workspace + orphans")
    .option("--force", "proceed despite uncommitted changes")
    .action(async (task, options) => {
      await withContext(async (context): Promise<undefined> => {
        await runCleanup({
          context,
          options: {
            ...(task === undefined ? {} : { task }),
            ...(options.all === undefined ? {} : { all: options.all }),
            ...(options.force === undefined ? {} : { force: options.force }),
          },
          io,
        });
      });
    });

  const source = program.command("source").description("inspect discovered task sources");
  source
    .command("list")
    .description("discovered task sources and their capabilities")
    .option("--json", "machine-readable output")
    .action(async (options) => {
      await withContext(async (context): Promise<undefined> => {
        runSourceList({ context, json: options.json === true, io });
      });
    });
  source
    .command("doctor")
    .argument("[name]", "source name (omit to check all)")
    .description("per-source deep check: contract, secrets, sandbox")
    .option("--json", "machine-readable output")
    .action(async (name, options) => {
      await withContext(async (context) =>
        await runSourceDoctor({
          context,
          ...(name === undefined ? {} : { name }),
          json: options.json === true,
          io,
        }),
      );
    });

  const repo = program.command("repo").description("in-session workspace commands");
  repo
    .command("add")
    .argument("<repo>", "repo directory name under workspace.baseDirectory")
    .description("acquire a repo worktree into the task workspace")
    .option("--task <id>", "explicit task (default: inferred)")
    .action(async (repoName, options) => {
      await withContext(async (context): Promise<undefined> => {
        await runRepoAdd({
          context,
          repo: repoName,
          ...(options.task === undefined ? {} : { task: options.task }),
          io,
        });
      });
    });

  const artifact = program.command("artifact").description("in-session artifact reporting");
  artifact
    .command("add")
    .argument("<locator>", "URL, path, or id identifying the artifact")
    .description("report an artifact produced for the task")
    .option("--kind <kind>", "pr | branch | document | file | ticket | … (default: guessed)")
    .option("--title <text>", "human-readable label")
    .option("--repo <name>", "repo this artifact belongs to, when relevant")
    .option("--task <id>", "explicit task (default: inferred)")
    .action(async (locator, options) => {
      await withContext(async (context): Promise<undefined> => {
        await runArtifactAdd({
          context,
          locator,
          options: {
            ...(options.kind === undefined ? {} : { kind: options.kind }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.repo === undefined ? {} : { repo: options.repo }),
            ...(options.task === undefined ? {} : { task: options.task }),
          },
          io,
        });
      });
    });

  program
    .command("done")
    .argument("[task]", "task id (default: inferred from session context)")
    .description("report completion; triggers source writeback")
    .option("--outcome <outcome>", "delivered | failed | stopped (default: delivered)")
    .option("--message <text>", "note delivered with the writeback")
    .option("--allow-dirty", "skip the dirty-worktree guard")
    .option("--task <id>", "explicit task (default: inferred from session context)")
    .action(async (task, options) => {
      const taskId = task ?? options.task;
      await withContext(async (context): Promise<undefined> => {
        await runDone({
          context,
          options: {
            ...(taskId === undefined ? {} : { task: taskId }),
            ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
            ...(options.message === undefined ? {} : { message: options.message }),
            ...(options.allowDirty === undefined ? {} : { allowDirty: options.allowDirty }),
          },
          io,
        });
      });
    });

  program
    .command("init")
    .description("write config interactively and verify the host")
    .option("--local", "write ./crew.config.jsonc instead of global")
    .option("--yes", "accept detected defaults, no prompts")
    .option("--force", "overwrite an existing config")
    .option("--dry-run", "print the config that would be written")
    .action(async (options) => {
      await plain(async () =>
        await runInit({
          environment,
          cwd: process.cwd(),
          options: {
            ...(options.local === undefined ? {} : { local: options.local }),
            ...(options.yes === undefined ? {} : { yes: options.yes }),
            ...(options.force === undefined ? {} : { force: options.force }),
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          },
          io,
        }),
      );
    });

  program
    .command("doctor")
    .description("check prerequisites, config, and source contracts")
    .option("--json", "machine-readable output")
    .action(async (options) => {
      await plain(async () =>
        await runDoctor({
          environment,
          cwd: process.cwd(),
          verbose: verbose(),
          json: options.json === true,
          io,
        }),
      );
    });

  program
    .command("upgrade")
    .argument("[version]", "exact version to install (default: latest)")
    .description("install the latest (or pinned) version of crew")
    .action(async (version) => {
      await plain(async (): Promise<undefined> => {
        await runUpgrade({
          ...(version === undefined ? {} : { version }),
          io,
          printOnly: truthyEnv(environment.GROUNDCREW_UPGRADE_PRINT_ONLY),
        });
      });
    });

  program
    .command("completions")
    .argument("<shell>", "bash | zsh | fish")
    .description("print a shell completion script")
    .action(async (shell) => {
      await plain(async (): Promise<undefined> => {
        runCompletions({ shell, io });
      });
    });

  return program;
}

function reportError(input: { error: unknown; io: Io; verbose: boolean }): void {
  process.exitCode = exitCodeFor(input.error);
  input.io.err(messageFor(input.error));
  if (input.verbose && input.error instanceof Error && input.error.stack !== undefined) {
    input.io.err(input.error.stack);
  }
}

function truthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/** Parses and runs the given argv (defaults to the process args). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const program = buildProgram();
  await program.parseAsync([...argv], { from: "user" });
}

await main();
