/**
 * Deterministic synchronization primitive for the e2e harness.
 *
 * The suite never sleeps for a fixed duration to "let something happen" (the
 * one exception is the scripted agent's explicit `sleep` step, which is part of
 * the system under test). Everywhere else, scenarios and the harness poll a
 * predicate until it holds, then continue immediately — or fail loudly with the
 * description of what they were waiting for.
 */

export interface PollOptions<T> {
  /** Human-readable description of the awaited condition, used in the timeout error. */
  readonly description: string;
  /** Returns a defined value when the condition holds, `undefined` while it does not. */
  readonly probe: () => T | undefined | Promise<T | undefined>;
  /** Overall budget before giving up. Default 10_000ms. */
  readonly timeoutMilliseconds?: number | undefined;
  /** Delay between probes. Default 25ms. */
  readonly intervalMilliseconds?: number | undefined;
}

/**
 * Polls `probe` until it returns a defined value, which is then returned.
 * Throws a descriptive error if the timeout elapses first, including the last
 * error thrown by `probe` (if any) so failures are diagnosable.
 */
export async function pollForValue<T>(options: PollOptions<T>): Promise<T> {
  const {
    description,
    probe,
    timeoutMilliseconds = 10_000,
    intervalMilliseconds = 25,
  } = options;

  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;

  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling is inherently sequential
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      const suffix =
        lastError === undefined ? "" : ` (last error: ${describeError(lastError)})`;
      throw new Error(
        `Timed out after ${timeoutMilliseconds}ms waiting for ${description}${suffix}`,
      );
    }

    // oxlint-disable-next-line no-await-in-loop -- polling is inherently sequential
    await delay(intervalMilliseconds);
  }
}

/**
 * Polls `condition` until it returns `true`. Thin boolean wrapper over
 * {@link pollForValue} for the common "wait until X exists" case.
 */
export async function pollUntil(options: {
  readonly description: string;
  readonly condition: () => boolean | Promise<boolean>;
  readonly timeoutMilliseconds?: number | undefined;
  readonly intervalMilliseconds?: number | undefined;
}): Promise<void> {
  const { description, condition, timeoutMilliseconds, intervalMilliseconds } = options;

  await pollForValue({
    description,
    timeoutMilliseconds,
    intervalMilliseconds,
    probe: async () => ((await condition()) ? true : undefined),
  });
}

/**
 * Sleeps for a fixed duration. Reserved for the scripted agent's `sleep` step;
 * scenarios must synchronize with {@link pollUntil}, never this.
 */
export async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
