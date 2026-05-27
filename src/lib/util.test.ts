import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinearClient } from "@linear/sdk";

import { captureConsoleError, captureConsoleLog } from "../testHelpers/consoleCapture.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import {
  errorMessage,
  getLinearClient,
  lazyLinearClient,
  log,
  logEvent,
  readEnvironmentVariable,
  resolveLinearApiKey,
  setLogFile,
  sleep,
  withLogOutputSuppressed,
} from "./util.ts";

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
  it("prints stable key-value fields and skips undefined fields", () => {
    const consoleLog = captureConsoleLog();

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

describe(withLogOutputSuppressed, () => {
  it("suppresses log output and restores logging afterwards", async () => {
    const consoleLog = captureConsoleLog();

    await withLogOutputSuppressed(async () => {
      log("hidden");
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

describe("Linear API key resolution", () => {
  const originalGroundcrewKey = readEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
  const originalLinearKey = readEnvironmentVariable("LINEAR_API_KEY");

  beforeEach(() => {
    deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    deleteEnvironmentVariable("LINEAR_API_KEY");
  });

  afterEach(() => {
    if (originalGroundcrewKey === undefined) {
      deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", originalGroundcrewKey);
    }
    if (originalLinearKey === undefined) {
      deleteEnvironmentVariable("LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("LINEAR_API_KEY", originalLinearKey);
    }
  });

  describe(resolveLinearApiKey, () => {
    it("returns LINEAR_API_KEY as the source when only it is set", () => {
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({ value: "lin_api_legacy", source: "LINEAR_API_KEY" });
    });

    it("returns GROUNDCREW_LINEAR_API_KEY as the source when only it is set", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({
        value: "lin_api_groundcrew",
        source: "GROUNDCREW_LINEAR_API_KEY",
      });
    });

    it("prefers GROUNDCREW_LINEAR_API_KEY when both are set", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({
        value: "lin_api_groundcrew",
        source: "GROUNDCREW_LINEAR_API_KEY",
      });
    });

    it("falls back to LINEAR_API_KEY when GROUNDCREW_LINEAR_API_KEY is empty", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "");
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({ value: "lin_api_legacy", source: "LINEAR_API_KEY" });
    });

    it("returns undefined when neither variable is set", () => {
      const actual = resolveLinearApiKey();

      expect(actual).toBeUndefined();
    });

    it("returns undefined when both variables are empty", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "");
      setEnvironmentVariable("LINEAR_API_KEY", "");

      const actual = resolveLinearApiKey();

      expect(actual).toBeUndefined();
    });
  });

  describe(getLinearClient, () => {
    it("returns a LinearClient when LINEAR_API_KEY is set", () => {
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = getLinearClient();

      expect(actual).toBeInstanceOf(LinearClient);
    });

    it("returns a LinearClient when GROUNDCREW_LINEAR_API_KEY is set", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");

      const actual = getLinearClient();

      expect(actual).toBeInstanceOf(LinearClient);
    });

    it("throws when neither variable is set", () => {
      expect(() => getLinearClient()).toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
    });

    it("throws when both variables are empty", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "");
      setEnvironmentVariable("LINEAR_API_KEY", "");

      expect(() => getLinearClient()).toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
    });
  });

  describe(lazyLinearClient, () => {
    it("defers and caches Linear client creation", () => {
      const client = new LinearClient({ apiKey: "lin_api_test" });
      const factory = vi.fn<() => LinearClient>(() => client);
      const actual = lazyLinearClient(factory);

      expect(factory).not.toHaveBeenCalled();
      expect(actual()).toBe(client);
      expect(actual()).toBe(client);
      expect(factory).toHaveBeenCalledTimes(1);
    });
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
