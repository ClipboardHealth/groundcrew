import { EventEmitter } from "node:events";
import process, { platform } from "node:process";

import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { holdIdleSleep } from "./power.ts";
import { setVerbose } from "./util.ts";

const spawnMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[], options: unknown) => FakeChildProcess>(),
);

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

interface FakeChildProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
  pid: number | undefined;
}

function makeChild(overrides: Partial<FakeChildProcess> = {}): FakeChildProcess {
  // oxlint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter APIs.
  const base = new EventEmitter();
  return Object.assign(base, {
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>().mockReturnValue(true),
    pid: 12_345 as number | undefined,
    ...overrides,
  });
}

describe(holdIdleSleep, () => {
  const originalPlatform = platform;
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    setVerbose(true);
    Object.defineProperty(process, "platform", { value: "darwin" });
    consoleLog = captureConsoleLog();
  });

  afterEach(() => {
    vi.clearAllMocks();
    setVerbose(false);
    consoleLog.restore();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("spawns caffeinate -i -w <pid> on macOS and releases it via SIGTERM on demand", () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const release = holdIdleSleep();

    expect(spawnMock).toHaveBeenCalledWith("caffeinate", ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
    expect(consoleLog.output()).toContain("event=power action=acquired pid=12345");

    release();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(consoleLog.output()).toContain("event=power action=released pid=12345");
  });

  it("returns a no-op release when explicitly disabled, even on macOS", () => {
    const release = holdIdleSleep(false);
    release();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toBe("");
  });

  it.each(["linux", "win32"] as const)(
    "returns a no-op release on %s without touching child_process or logging",
    (osPlatform) => {
      Object.defineProperty(process, "platform", { value: osPlatform });

      const release = holdIdleSleep();
      release();

      expect(spawnMock).not.toHaveBeenCalled();
      // Non-macOS is a true no-op: no acquire/release events, no error logs.
      // Matches AO's power module contract — platform check inside the module,
      // no caller-visible side effects off macOS.
      expect(consoleLog.output()).toBe("");
    },
  );

  it("logs spawn_failed and returns a no-op release when spawn throws synchronously", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("ENOMEM");
    });

    const release = holdIdleSleep();
    release();

    expect(consoleLog.output()).toContain("event=power action=spawn_failed error=ENOMEM");
  });

  it("coerces non-Error spawn rejections to a string for the log line", () => {
    spawnMock.mockImplementation(() => {
      // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- exercising the non-Error catch branch
      throw "boom";
    });

    holdIdleSleep();

    expect(consoleLog.output()).toContain("event=power action=spawn_failed error=boom");
  });

  it("logs an error event when the child emits 'error' asynchronously", () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    holdIdleSleep();
    child.emit("error", new Error("ENOENT: caffeinate not found"));

    expect(consoleLog.output()).toContain(
      'event=power action=error error="ENOENT: caffeinate not found"',
    );
  });

  it("is idempotent — a second release is a no-op and does not re-kill the child", () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const release = holdIdleSleep();
    release();
    release();

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("logs release_failed when killing the child throws an Error", () => {
    const child = makeChild({
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>().mockImplementation(() => {
        throw new Error("ESRCH");
      }),
    });
    spawnMock.mockReturnValue(child);

    const release = holdIdleSleep();
    release();

    expect(consoleLog.output()).toContain("event=power action=release_failed error=ESRCH");
  });

  it("logs release_failed with the stringified value when killing throws a non-Error", () => {
    const child = makeChild({
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>().mockImplementation(() => {
        // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- exercising the non-Error catch branch
        throw "denied";
      }),
    });
    spawnMock.mockReturnValue(child);

    const release = holdIdleSleep();
    release();

    expect(consoleLog.output()).toContain("event=power action=release_failed error=denied");
  });

  it("omits the pid field when the spawned child has no pid", () => {
    const child = makeChild({ pid: undefined });
    spawnMock.mockReturnValue(child);

    const release = holdIdleSleep();
    release();

    expect(consoleLog.output()).toContain("event=power action=acquired");
    expect(consoleLog.output()).not.toContain("pid=");
  });
});
