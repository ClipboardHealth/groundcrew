import {
  runVerify,
  runVerifyCheck,
  thrownErrorMessage,
  type CheckResult,
  type VerifyCheck,
} from "../../scripts/verifyRunner.ts";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

type CheckHandler = (check: VerifyCheck) => Promise<CheckResult>;
type CheckRunner = (input: { check: VerifyCheck }) => Promise<CheckResult>;

function unresolvedDeferred(): void {
  throw new Error("Deferred resolver was used before initialization");
}

function createDeferred(): Deferred {
  let resolveDeferred = unresolvedDeferred;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });

  return { promise, resolve: resolveDeferred };
}

function passingResult(check: VerifyCheck, durationMs = 1): CheckResult {
  return { durationMs, name: check.name, ok: true, output: "" };
}

function runCheckWithHandlers(
  handlers: ReadonlyMap<string, CheckHandler>,
): (input: { check: VerifyCheck }) => Promise<CheckResult> {
  return async ({ check }) => await handlerFor({ check, handlers })(check);
}

function handlerFor(input: {
  check: VerifyCheck;
  handlers: ReadonlyMap<string, CheckHandler>;
}): CheckHandler {
  const { check, handlers } = input;
  const handler = handlers.get(check.name);
  if (handler === undefined) {
    throw new Error(`No handler for ${check.name}`);
  }
  return handler;
}

describe(runVerify, () => {
  it("runs exclusive checks only after parallel checks settle", async () => {
    const events: string[] = [];
    const parallelCheckDone = createDeferred();
    const handlers = new Map<string, CheckHandler>([
      [
        "lint",
        async (check) => {
          events.push(`start:${check.name}`);
          await parallelCheckDone.promise;
          events.push(`finish:${check.name}`);
          return passingResult(check);
        },
      ],
      [
        "test",
        async (check) => {
          events.push(`start:${check.name}`, `finish:${check.name}`);
          return passingResult(check);
        },
      ],
    ]);
    const runCheck = vi.fn<CheckRunner>(runCheckWithHandlers(handlers));

    const verifyPromise = runVerify({
      checks: [
        { cmd: "lint", mode: "parallel", name: "lint" },
        { cmd: "test", mode: "exclusive", name: "test" },
      ],
      now: () => 0,
      print: vi.fn<(message: string) => void>(),
      runCheck,
    });
    await Promise.resolve();

    expect(events).toStrictEqual(["start:lint"]);

    parallelCheckDone.resolve();
    const actual = await verifyPromise;

    expect(actual.ok).toBe(true);
    expect(events).toStrictEqual(["start:lint", "finish:lint", "start:test", "finish:test"]);
  });

  it("prints failed checks and passing check output in the summary", async () => {
    const printed: string[] = [];
    const handlers = new Map<string, CheckHandler>([
      ["knip", async (check) => ({ durationMs: 3, name: check.name, ok: false, output: "" })],
      [
        "test",
        async (check) => ({
          durationMs: 2,
          name: check.name,
          ok: false,
          output: "coverage failed\nline detail",
        }),
      ],
      [
        "lint",
        async (check) => ({
          durationMs: 1500,
          name: check.name,
          ok: true,
          output: "lint warning",
        }),
      ],
    ]);
    const runCheck = vi.fn<CheckRunner>(runCheckWithHandlers(handlers));

    const actual = await runVerify({
      checks: [
        { cmd: "lint", mode: "parallel", name: "lint" },
        { cmd: "knip", mode: "parallel", name: "knip" },
        { cmd: "test", mode: "exclusive", name: "test" },
      ],
      now: () => 1500,
      print: (message) => {
        printed.push(message);
      },
      runCheck,
    });

    const output = printed.join("\n");
    expect(actual.ok).toBe(false);
    expect(output).toContain("✓ lint (1.5s)");
    expect(output).toContain("✗ knip (3ms)");
    expect(output).toContain("✗ test (2ms)");
    expect(output).toContain("Failed (2):");
    expect(output).toContain("    coverage failed\n    line detail");
    expect(output).toContain("Passed with output (1):");
    expect(output).toContain("    lint warning");
  });
});

describe(runVerifyCheck, () => {
  it("captures stdout and stderr for successful checks", async () => {
    const actual = await runVerifyCheck({
      check: {
        cmd: "node -e \"process.stdout.write('out'); process.stderr.write('err')\"",
        mode: "parallel",
        name: "sample",
      },
    });

    expect(actual.name).toBe("sample");
    expect(actual.ok).toBe(true);
    expect(actual.output).toBe("out\nerr");
  });

  it("captures command failure output", async () => {
    const actual = await runVerifyCheck({
      check: {
        cmd: "node -e \"process.stderr.write('bad'); process.exit(2)\"",
        mode: "parallel",
        name: "sample",
      },
    });

    expect(actual.name).toBe("sample");
    expect(actual.ok).toBe(false);
    expect(actual.output).toContain("Command failed: node -e");
    expect(actual.output).toContain("bad");
  });

  it("reports inherited-output command failures without buffering output", async () => {
    const actual = await runVerifyCheck({
      check: {
        cmd: 'node -e "process.exit(2)"',
        mode: "exclusive",
        name: "sample",
        outputMode: "inherited",
      },
    });

    expect(actual.name).toBe("sample");
    expect(actual.ok).toBe(false);
    expect(actual.output).toContain("Command failed: node -e");
    expect(actual.output).toContain("Exited with code 2");
  });

  it("runs successful inherited-output checks without buffering output", async () => {
    const actual = await runVerifyCheck({
      check: {
        cmd: 'node -e ""',
        mode: "exclusive",
        name: "sample",
        outputMode: "inherited",
      },
    });

    expect(actual.name).toBe("sample");
    expect(actual.ok).toBe(true);
    expect(actual.output).toBe("");
  });

  it("times out inherited-output checks", async () => {
    const actual = await runVerifyCheck({
      check: {
        cmd: 'node -e "setTimeout(() => {}, 1000)"',
        mode: "exclusive",
        name: "sample",
        outputMode: "inherited",
        timeoutMs: 10,
      },
    });

    expect(actual.name).toBe("sample");
    expect(actual.ok).toBe(false);
    expect(actual.output).toContain("Command timed out after 10ms");
  });

  it("reports inherited-output signal failures", async () => {
    const actual = await runVerifyCheck({
      check: {
        cmd: "kill -TERM $$",
        mode: "exclusive",
        name: "sample",
        outputMode: "inherited",
      },
    });

    expect(actual.name).toBe("sample");
    expect(actual.ok).toBe(false);
    expect(actual.output).toContain("Terminated by signal SIGTERM");
  });
});

describe(thrownErrorMessage, () => {
  it("normalizes Error and non-Error failures", () => {
    expect(thrownErrorMessage(new Error("boom"))).toBe("boom");
    expect(thrownErrorMessage("plain")).toBe("plain");
  });
});
