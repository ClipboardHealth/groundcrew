/**
 * groundcrew orchestrator — polls Linear projects and spins up workspace +
 * git-worktree pairs for ready tickets. Each tick fetches the board, runs
 * the cleaner, the reviewer, and the dispatcher; logging from those modules is
 * the orchestrator's user-facing output.
 */

import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch } from "../lib/pullRequests.ts";
import { type BoardState, RepositoryResolutionError } from "../lib/ticketSource.ts";
import { getUsageByModel, type UsageByModel } from "../lib/usage.ts";
import { errorMessage, log, sleep } from "../lib/util.ts";
import { worktrees } from "../lib/worktrees.ts";
import { type Cleaner, createCleaner } from "./cleaner.ts";
import { createDispatcher, type Dispatcher } from "./dispatcher.ts";
import { createReviewer, type Reviewer } from "./reviewer.ts";

const RATE_LIMIT_DELAY_MS = 60_000;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_ATTEMPTS = 3;
const MS_PER_SECOND = 1000;

async function withRetry<T>(
  function_: () => Promise<T>,
  signal?: AbortSignal,
  maxRetries = RETRY_MAX_ATTEMPTS,
  baseDelayMs = RETRY_BASE_DELAY_MS,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retry loop sequences attempts deliberately
      return await function_();
    } catch (error) {
      /* v8 ignore next 2 @preserve -- fetch() warns-and-skips since PR#88; guard is a defensive no-op in practice */
      if (error instanceof RepositoryResolutionError) {
        throw error;
      }
      if (attempt === maxRetries) {
        throw error;
      }
      const message = errorMessage(error);
      const isRateLimit = message.includes("Rate limit");
      const delay = isRateLimit ? RATE_LIMIT_DELAY_MS : baseDelayMs * 2 ** attempt;
      log(`Retrying in ${delay / MS_PER_SECOND}s (attempt ${attempt + 1}/${maxRetries})...`);
      // oxlint-disable-next-line no-await-in-loop -- backoff is intentionally sequential
      await sleep(delay, signal);
      if (signal?.aborted === true) {
        throw new WatchLoopShutdownError();
      }
    }
  }
  /* v8 ignore next @preserve -- the for-loop above always returns or throws */
  throw new Error("unreachable");
}

class WatchLoopShutdownError extends Error {
  public constructor() {
    super("watch loop shutdown requested");
    this.name = "WatchLoopShutdownError";
  }
}

export interface OrchestratorOptions {
  watch: boolean;
  dryRun: boolean;
}

async function fetchUsageOrEmpty(
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<UsageByModel> {
  try {
    return await getUsageByModel(config, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    log(`Usage check failed, proceeding without limits: ${errorMessage(error)}`);
    return {};
  }
}

export async function orchestrate(options: OrchestratorOptions): Promise<void> {
  const config = await loadConfig();

  // Build all sources (Linear implicit + any user-declared shell adapters).
  // sourcesFromConfig synthesizes the implicit linear source from the config;
  // this ensures the Linear adapter's markInProgress is reachable via board.
  const allSources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
  const board: Board = createBoard(allSources);
  await board.verify();

  const cleaner: Cleaner = createCleaner({ config });
  const reviewer: Reviewer = createReviewer({
    board,
    findPullRequests: findPullRequestsForBranch,
  });
  const dispatcher: Dispatcher = createDispatcher({ config, board });

  // Folded into the dispatcher's idle log lines in watch mode so each idle
  // tick prints one combined line instead of "<reason>" + "Next poll in Xs".
  const idleSuffix = options.watch
    ? `; next poll in ${config.orchestrator.pollIntervalMilliseconds / MS_PER_SECOND}s`
    : undefined;

  const tick = async (signal?: AbortSignal): Promise<void> => {
    const state: BoardState = await withRetry(async () => await board.fetch(), signal);

    const worktreeEntries = worktrees.list(config);
    const tickArguments = {
      state,
      worktreeEntries,
      dryRun: options.dryRun,
      ...(signal === undefined ? {} : { signal }),
    };

    await cleaner.runOnce(tickArguments);

    await reviewer.runOnce(tickArguments);

    await dispatcher.runOnce({
      ...tickArguments,
      // Lazy: dispatcher only invokes this after its own early-returns, so
      // an idle board doesn't burn a codexbar shell-out per tick.
      usage: async (usageSignal) => await fetchUsageOrEmpty(config, usageSignal),
      ...(idleSuffix === undefined ? {} : { idleSuffix }),
    });
  };

  await (options.watch ? runWatchLoop(tick, config) : tick());
}

const SHUTDOWN_EXIT_CODE = 130;
const SHUTDOWN_FORCE_EXIT_DELAY_MS = 10_000;
type ShutdownSignal = "SIGINT" | "SIGTERM";
const SHUTDOWN_EXIT_CODES = {
  SIGINT: SHUTDOWN_EXIT_CODE,
  SIGTERM: 143,
} satisfies Record<ShutdownSignal, number>;

function signalExitCode(signal: ShutdownSignal): number {
  return SHUTDOWN_EXIT_CODES[signal];
}

async function runWatchLoop(
  tick: (signal: AbortSignal) => Promise<void>,
  config: ResolvedConfig,
): Promise<void> {
  const shutdown = new AbortController();
  let forceExitTimer: NodeJS.Timeout | undefined;
  const forceExit = (signal: ShutdownSignal): never => {
    log(`${signal} shutdown did not finish; forcing exit`);
    // oxlint-disable-next-line node/no-process-exit -- shutdown escape hatch for non-abortable hangs
    process.exit(signalExitCode(signal));
  };
  // First signal asks the loop to drain after the current tick. A second
  // signal escalates immediately. The timer covers non-abortable work that
  // never returns from the current tick.
  const requestShutdown = (signal: ShutdownSignal): void => {
    if (shutdown.signal.aborted) {
      log(`${signal} received again — forcing exit`);
      forceExit(signal);
    }
    log(
      `Shutdown requested (${signal}); finishing current tick then exiting. Press again to force.`,
    );
    shutdown.abort();
    forceExitTimer = setTimeout(() => {
      forceExit(signal);
    }, SHUTDOWN_FORCE_EXIT_DELAY_MS);
  };
  const handleSigint = (): void => {
    requestShutdown("SIGINT");
  };
  const handleSigterm = (): void => {
    requestShutdown("SIGTERM");
  };
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  try {
    while (!shutdown.signal.aborted) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- watch loop ticks sequentially with a delay between
        await tick(shutdown.signal);
      } catch (error) {
        if (error instanceof WatchLoopShutdownError) {
          break;
        }
        /* v8 ignore next 2 @preserve -- fetch() warns-and-skips since PR#88; guard is a defensive no-op in practice */
        if (error instanceof RepositoryResolutionError) {
          throw error;
        }
        const message = errorMessage(error);
        if (message.includes("Signal: SIGINT")) {
          if (!shutdown.signal.aborted) {
            requestShutdown("SIGINT");
          }
          break;
        }
        log(`Error: ${message}`);
      }
      if (shutdown.signal.aborted) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- watch loop is intentionally serial
      await sleep(config.orchestrator.pollIntervalMilliseconds, shutdown.signal);
    }
  } finally {
    if (forceExitTimer !== undefined) {
      clearTimeout(forceExitTimer);
    }
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}
