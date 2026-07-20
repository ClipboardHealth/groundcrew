import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Presenter, PresenterProbe } from "../session/index.js";
import type { DispatchDeps, TickReport } from "./types.js";
import { watchLoop } from "./watch.js";

// oxlint-disable-next-line node/no-process-env -- the launch gate resolves binaries on the ambient PATH
const PATH_ENV = process.env["PATH"] ?? "";

class IdlePresenter implements Presenter {
  public async open(): Promise<void> {
    // noop
  }

  public async probe(): Promise<PresenterProbe> {
    return { available: true, sessions: [] };
  }

  public async close(): Promise<void> {
    // noop
  }

  public async accessHint(): Promise<string | undefined> {
    return undefined;
  }
}

/** A presenter whose probe always throws, forcing every tick to fail. */
class FailingPresenter implements Presenter {
  public async open(): Promise<void> {
    // noop
  }

  public async probe(): Promise<PresenterProbe> {
    throw new Error("probe boom");
  }

  public async close(): Promise<void> {
    // noop
  }

  public async accessHint(): Promise<string | undefined> {
    return undefined;
  }
}

/** Collects each value and aborts once `limit` is reached — kept out of the test body. */
function collectAndAbort<T>(
  sink: T[],
  controller: AbortController,
  limit: number,
): (value: T) => void {
  return (value: T): void => {
    sink.push(value);
    if (sink.length >= limit) {
      controller.abort();
    }
  };
}

let stateRoot: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crew-watch-"));
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function deps(presenter: Presenter): DispatchDeps {
  return {
    stateRoot,
    workspaceConfig: { baseDirectory: path.join(stateRoot, "repos") },
    presenter,
    sources: [],
    agents: { profiles: {} },
    maximumInProgress: 1,
    environment: { PATH: PATH_ENV },
  };
}

describe("watchLoop", () => {
  it("ticks repeatedly until the signal aborts", async () => {
    const controller = new AbortController();
    const reports: TickReport[] = [];

    await watchLoop({
      ...deps(new IdlePresenter()),
      pollIntervalMilliseconds: 1,
      signal: controller.signal,
      onTick: collectAndAbort(reports, controller, 3),
    });

    expect(reports.length).toBe(3);
  });

  it("reconciles every Nth cycle (startup always reconciles)", async () => {
    const controller = new AbortController();
    const reports: TickReport[] = [];

    await watchLoop({
      ...deps(new IdlePresenter()),
      pollIntervalMilliseconds: 1,
      reconcileEvery: 2,
      signal: controller.signal,
      onTick: collectAndAbort(reports, controller, 3),
    });

    // Cycle 0 reconciles, cycle 1 does not, cycle 2 reconciles.
    expect(reports.map((report) => report.reconcile !== undefined)).toEqual([true, false, true]);
  });

  it("surfaces a tick error without stopping the loop", async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    let ticks = 0;

    await watchLoop({
      ...deps(new FailingPresenter()),
      pollIntervalMilliseconds: 1,
      signal: controller.signal,
      onError: collectAndAbort(errors, controller, 2),
      onTick: () => {
        ticks += 1;
      },
    });

    // The loop survived the first error to reach the second; onTick never runs on a thrown tick.
    expect(errors.length).toBe(2);
    expect(ticks).toBe(0);
  });
});
