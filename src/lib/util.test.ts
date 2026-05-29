import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureConsoleError, captureConsoleLog } from "../testHelpers/consoleCapture.ts";
import {
  debug,
  errorMessage,
  failMark,
  isVerbose,
  log,
  logEvent,
  okMark,
  setLogFile,
  setVerbose,
  sleep,
  styleDim,
  styleWarning,
  withLogOutputSuppressed,
} from "./util.ts";

// Verbose is module-global; each describe that enables it resets afterward so
// the diagnostic tier can't leak onto another case's console assertions.

describe(sleep, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only after the timer fully elapses", async () => {
    const delayMs = 500;
    const tracker = vi.fn<() => void>();
    const settled = sleep(delayMs).then(tracker);

    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(tracker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(tracker).toHaveBeenCalledTimes(1);
  });

  it("resolves early when the abort signal fires mid-wait", async () => {
    const controller = new AbortController();
    const tracker = vi.fn<() => void>();
    const settled = sleep(60_000, controller.signal).then(tracker);

    await vi.advanceTimersByTimeAsync(1);
    expect(tracker).not.toHaveBeenCalled();

    controller.abort();
    await settled;

    expect(tracker).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tracker = vi.fn<() => void>();

    await sleep(60_000, controller.signal).then(tracker);

    expect(tracker).toHaveBeenCalledTimes(1);
  });
});

describe(log, () => {
  it("prefixes the message with a bracketed timestamp", () => {
    const consoleLog = captureConsoleLog();

    log("hello world");

    expect(consoleLog.calls).toHaveLength(1);
    expect(consoleLog.output()).toMatch(/^\[.+] hello world$/);
    consoleLog.restore();
  });
});

describe(logEvent, () => {
  afterEach(() => {
    setVerbose(false);
  });

  it("stays off the console by default", () => {
    const consoleLog = captureConsoleLog();

    logEvent("dispatch", { outcome: "skipped" });

    expect(consoleLog.calls).toHaveLength(0);
    consoleLog.restore();
  });

  it("prints stable key-value fields and skips undefined fields under verbose", () => {
    const consoleLog = captureConsoleLog();
    setVerbose(true);

    logEvent("dispatch", {
      outcome: "skipped",
      reason: "blocked",
      empty: undefined,
      blockers: ["TEAM-1:In Progress"],
    });

    expect(consoleLog.output()).toBe(
      'event=dispatch outcome=skipped reason=blocked blockers="TEAM-1:In Progress"',
    );
    consoleLog.restore();
  });
});

describe(debug, () => {
  afterEach(() => {
    setVerbose(false);
  });

  it("stays off the console by default", () => {
    const consoleLog = captureConsoleLog();

    debug("diagnostic detail");

    expect(consoleLog.calls).toHaveLength(0);
    consoleLog.restore();
  });

  it("echoes a timestamped line to the console under verbose", () => {
    const consoleLog = captureConsoleLog();
    setVerbose(true);

    debug("diagnostic detail");

    expect(consoleLog.calls).toHaveLength(1);
    expect(consoleLog.output()).toMatch(/^\[.+] diagnostic detail$/);
    consoleLog.restore();
  });
});

describe(withLogOutputSuppressed, () => {
  // logEvent only reaches the console under verbose; these cases assert the
  // visible event lines, so opt in.
  beforeEach(() => {
    setVerbose(true);
  });

  afterEach(() => {
    setVerbose(false);
  });

  it("suppresses log output and restores logging afterwards", async () => {
    const consoleLog = captureConsoleLog();

    await withLogOutputSuppressed(async () => {
      log("hidden");
      debug("hidden-debug");
      logEvent("hidden-event", {});
    });
    log("visible");

    expect(consoleLog.output()).toMatch(/visible/);
    expect(consoleLog.output()).not.toMatch(/hidden/);
    consoleLog.restore();
  });

  it("keeps logs suppressed through nested calls", async () => {
    const consoleLog = captureConsoleLog();

    await withLogOutputSuppressed(async () => {
      log("hidden-outer");
      logEvent("hidden-outer-event", {});
      await withLogOutputSuppressed(async () => {
        log("hidden-inner");
        logEvent("hidden-inner-event", {});
      });
      log("hidden-after-inner");
      logEvent("hidden-after-inner-event", {});
    });
    log("visible");
    logEvent("visible-event", { outcome: "ok" });

    expect(consoleLog.output()).toMatch(/visible/);
    expect(consoleLog.output()).toMatch(/event=visible-event outcome=ok/);
    expect(consoleLog.output()).not.toMatch(/hidden/);
    consoleLog.restore();
  });

  it("restores logging after the suppressed operation throws", async () => {
    const consoleLog = captureConsoleLog();

    await expect(
      withLogOutputSuppressed(async () => {
        log("hidden");
        logEvent("hidden-event", {});
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    log("visible");
    logEvent("visible-event", { outcome: "ok" });

    expect(consoleLog.output()).toMatch(/visible/);
    expect(consoleLog.output()).toMatch(/event=visible-event outcome=ok/);
    expect(consoleLog.output()).not.toMatch(/hidden/);
    consoleLog.restore();
  });
});

describe(setLogFile, () => {
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "groundcrew-log-file-"));
  });

  afterEach(() => {
    setLogFile(undefined);
    rmSync(temporary, { recursive: true, force: true });
  });

  it("tees log() output to the configured file, creating the parent dir", () => {
    const consoleLog = captureConsoleLog();
    const path = join(temporary, "nested", "groundcrew.log");
    setLogFile(path);

    log("hello world");

    expect(consoleLog.output()).toMatch(/^\[.+] hello world$/);
    expect(readFileSync(path, "utf8")).toMatch(/^\[.+] hello world\n$/);
    consoleLog.restore();
  });

  it("tees logEvent() output to the configured file", () => {
    const consoleLog = captureConsoleLog();
    const path = join(temporary, "events.log");
    setLogFile(path);

    logEvent("dispatch", { outcome: "started", ticket: "TEAM-1" });

    expect(readFileSync(path, "utf8")).toBe("event=dispatch outcome=started ticket=TEAM-1\n");
    consoleLog.restore();
  });

  it("tees debug() output to the configured file even when off the console", () => {
    const consoleLog = captureConsoleLog();
    const path = join(temporary, "debug.log");
    setLogFile(path);

    debug("diagnostic detail");

    expect(consoleLog.calls).toHaveLength(0);
    expect(readFileSync(path, "utf8")).toMatch(/^\[.+] diagnostic detail\n$/);
    consoleLog.restore();
  });

  it("appends successive writes to the same file", () => {
    const consoleLog = captureConsoleLog();
    const path = join(temporary, "events.log");
    setLogFile(path);

    logEvent("dispatch", { outcome: "started" });
    logEvent("cleanup", { outcome: "workspace_closed" });

    expect(readFileSync(path, "utf8")).toBe(
      "event=dispatch outcome=started\nevent=cleanup outcome=workspace_closed\n",
    );
    consoleLog.restore();
  });

  it("does not write to disk when no log file has been set", () => {
    const consoleLog = captureConsoleLog();
    const path = join(temporary, "events.log");

    logEvent("dispatch", { outcome: "started" });

    expect(existsSync(path)).toBe(false);
    consoleLog.restore();
  });

  it("disables file logging after a broken destination, warning once", () => {
    const consoleLog = captureConsoleLog();
    const consoleError = captureConsoleError();
    // A path whose parent is an existing regular file — mkdir will throw.
    const path = join(temporary, "events.log");
    setLogFile(path);
    logEvent("first", {});
    setLogFile(join(path, "trapped.log"));

    logEvent("second", {});
    logEvent("third", {});

    expect(consoleError.output()).toMatch(/disabling file logging/);
    expect(consoleError.calls).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("event=first\n");
    consoleLog.restore();
    consoleError.restore();
  });
});

describe(setVerbose, () => {
  afterEach(() => {
    setVerbose(false);
  });

  it("defaults to non-verbose and toggles", () => {
    expect(isVerbose()).toBe(false);

    setVerbose(true);

    expect(isVerbose()).toBe(true);
  });
});

describe("styling helpers", () => {
  // vitest runs with a piped stdout, so styleText emits no ANSI — the markers
  // and styled text fall back to their plain glyphs. The dim/color only appears
  // in a real color-capable TTY.
  it("returns plain glyphs and text without a color-capable stdout", () => {
    expect(okMark()).toBe("✓");
    expect(failMark()).toBe("✗");
    expect(styleWarning("WARNING: x")).toBe("WARNING: x");
    expect(styleDim("[12:00]")).toBe("[12:00]");
  });
});

describe(errorMessage, () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the string when given a string", () => {
    expect(errorMessage("nope")).toBe("nope");
  });

  it("JSON-stringifies plain objects", () => {
    expect(errorMessage({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("falls back to Object.prototype.toString when JSON fails", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const actual = errorMessage(circular);

    expect(actual).toBe("[object Object]");
  });
});
