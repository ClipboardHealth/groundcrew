import { createRepeatedFailureLog } from "./repeatedFailures.ts";

describe(createRepeatedFailureLog, () => {
  it("reports a newly seen failure as first", () => {
    const failureLog = createRepeatedFailureLog();

    const actual = failureLog.observeAll({
      occurrences: [{ key: "team-1", message: "worktree is dirty" }],
    });

    expect(actual.get("team-1")).toEqual({ recurrence: "first", repeats: 1 });
  });

  it("suppresses an unchanged repeat", () => {
    const failureLog = createRepeatedFailureLog();
    const occurrences = [{ key: "team-1", message: "worktree is dirty" }];
    failureLog.observeAll({ occurrences });

    const actual = failureLog.observeAll({ occurrences });

    expect(actual.get("team-1")).toEqual({ recurrence: "suppressed", repeats: 2 });
  });

  it("reports a changed message and restarts the count", () => {
    const failureLog = createRepeatedFailureLog();
    failureLog.observeAll({ occurrences: [{ key: "team-1", message: "1 untracked file" }] });

    const actual = failureLog.observeAll({
      occurrences: [{ key: "team-1", message: "2 untracked files" }],
    });

    expect(actual.get("team-1")).toEqual({ recurrence: "changed", repeats: 1 });
  });

  it("reports an ongoing summary every thirtieth unchanged repeat", () => {
    const failureLog = createRepeatedFailureLog();
    const occurrences = [{ key: "team-1", message: "worktree is dirty" }];

    const actual = Array.from({ length: 60 }, () =>
      failureLog.observeAll({ occurrences }).get("team-1"),
    );

    expect(actual[29]).toEqual({ recurrence: "ongoing", repeats: 30 });
    expect(actual[30]).toEqual({ recurrence: "suppressed", repeats: 31 });
    expect(actual[59]).toEqual({ recurrence: "ongoing", repeats: 60 });
  });

  it("tracks each key independently within one batch", () => {
    const failureLog = createRepeatedFailureLog();
    failureLog.observeAll({ occurrences: [{ key: "team-1", message: "worktree is dirty" }] });

    const actual = failureLog.observeAll({
      occurrences: [
        { key: "team-1", message: "worktree is dirty" },
        { key: "team-2", message: "workspace is locked" },
      ],
    });

    expect(actual.get("team-1")).toEqual({ recurrence: "suppressed", repeats: 2 });
    expect(actual.get("team-2")).toEqual({ recurrence: "first", repeats: 1 });
  });

  it("forgets a key that is absent from a later batch", () => {
    const failureLog = createRepeatedFailureLog();
    const occurrences = [{ key: "team-1", message: "worktree is dirty" }];
    failureLog.observeAll({ occurrences });
    failureLog.observeAll({ occurrences: [] });

    const actual = failureLog.observeAll({ occurrences });

    expect(actual.get("team-1")).toEqual({ recurrence: "first", repeats: 1 });
  });
});
