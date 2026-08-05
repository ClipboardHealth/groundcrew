/**
 * In-memory recurrence tracker that lets a polling loop announce a failure when
 * it starts, when its message changes, and periodically while it persists,
 * without re-logging the identical line on every poll.
 */

type FailureRecurrence = "changed" | "first" | "ongoing" | "suppressed";

export interface FailureOccurrence {
  key: string;
  message: string;
}

export interface FailureObservation {
  recurrence: FailureRecurrence;
  repeats: number;
}

export interface RepeatedFailureLog {
  /**
   * Records one poll's complete set of failures and returns how each should be
   * reported. Keys absent from `occurrences` are forgotten, so a failure that
   * clears and later recurs is announced again — callers must therefore pass
   * every failure they track, not a subset.
   */
  observeAll: (arguments_: {
    occurrences: readonly FailureOccurrence[];
  }) => ReadonlyMap<string, FailureObservation>;
}

const ONGOING_SUMMARY_INTERVAL = 30;

export function createRepeatedFailureLog(): RepeatedFailureLog {
  let tracked = new Map<string, FailureOccurrence & { repeats: number }>();

  function observeAll(arguments_: {
    occurrences: readonly FailureOccurrence[];
  }): ReadonlyMap<string, FailureObservation> {
    const { occurrences } = arguments_;
    const nextTracked = new Map<string, FailureOccurrence & { repeats: number }>();
    const observations = new Map<string, FailureObservation>();

    for (const occurrence of occurrences) {
      const previous = tracked.get(occurrence.key);
      const unchanged = previous !== undefined && previous.message === occurrence.message;
      const repeats = unchanged ? previous.repeats + 1 : 1;

      nextTracked.set(occurrence.key, { ...occurrence, repeats });
      observations.set(occurrence.key, {
        recurrence: recurrenceOf({ previous, unchanged, repeats }),
        repeats,
      });
    }

    tracked = nextTracked;
    return observations;
  }

  return { observeAll };
}

function recurrenceOf(arguments_: {
  previous: FailureOccurrence | undefined;
  unchanged: boolean;
  repeats: number;
}): FailureRecurrence {
  const { previous, unchanged, repeats } = arguments_;
  if (previous === undefined) {
    return "first";
  }

  if (!unchanged) {
    return "changed";
  }

  return repeats % ONGOING_SUMMARY_INTERVAL === 0 ? "ongoing" : "suppressed";
}
