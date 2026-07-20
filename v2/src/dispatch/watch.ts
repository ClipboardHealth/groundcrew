/**
 * The `--watch` loop (design doc §7.1): repeated {@link tick}s spaced by
 * `orchestrator.pollIntervalMilliseconds`. The loop itself owns no process
 * signals — Shell passes an `AbortSignal` and does the SIGINT/SIGTERM wiring;
 * reconcile-on-startup plus every-tick reconcile is the crash-safety guarantee
 * (§10.5), so this stays a thin scheduler.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { tick } from "./pipeline.js";
import type { DispatchDeps, TickReport } from "./types.js";

export interface WatchLoopInput extends DispatchDeps {
  pollIntervalMilliseconds: number;
  /** Aborts the loop between ticks (Shell wires it to process signals). */
  signal?: AbortSignal;
  /** Reconcile every Nth tick; default 1 (every tick). */
  reconcileEvery?: number;
  /** Observe each tick's report (rendering, tests). */
  onTick?: (report: TickReport) => void;
}

/**
 * Runs ticks until the signal aborts. The first tick always reconciles (startup
 * guarantee); subsequent ticks reconcile every Nth cycle. A thrown tick is not
 * fatal — it is surfaced through `onError` (or swallowed) and the loop continues.
 */
export async function watchLoop(
  input: WatchLoopInput & { onError?: (error: unknown) => void },
): Promise<void> {
  const reconcileEvery = Math.max(1, input.reconcileEvery ?? 1);
  let cycle = 0;

  for (;;) {
    if (isAborted(input.signal)) {
      break;
    }

    const shouldReconcile = cycle % reconcileEvery === 0;
    try {
      // eslint-disable-next-line no-await-in-loop -- the loop is inherently sequential
      const report = await tick({ ...input, reconcile: shouldReconcile });
      input.onTick?.(report);
    } catch (error) {
      input.onError?.(error);
    }

    cycle += 1;
    if (isAborted(input.signal)) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- pace the poll cadence
    await delay(input.pollIntervalMilliseconds, input.signal);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(milliseconds, undefined, signal === undefined ? undefined : { signal });
  } catch {
    // Aborted mid-delay: the loop's next abort check ends it cleanly.
  }
}
