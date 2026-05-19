import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTmuxOpenArgv } from "./tmuxAdapter.ts";

const tmuxAvailable = ((): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!tmuxAvailable)("workspaces.open (tmux) — real tmux integration", () => {
  let sandbox: string;
  let sessionName: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "groundcrew-tmux-it-"));
    sessionName = `groundcrew-it-${process.pid}-${Date.now()}`;
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-n", "_idle"]);
  });

  afterAll(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", sessionName]);
    } catch {
      // already gone — that's fine
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  // oxlint-disable-next-line jest/consistent-test-it -- project convention (.rules/common/testing.md) mandates `it`; oxlint's `consistent-test-it` rule doesn't recognize `describe.skipIf(...)` as a describe block and so misfires here.
  it("pipe-pane captures pane stdout to the log file", async () => {
    const logPath = join(sandbox, "TEST-1-20260517-150000.log");
    const argv = buildTmuxOpenArgv({
      sessionName,
      spec: {
        name: "TEST-1",
        cwd: sandbox,
        command: "echo hello-from-tmux-test",
      },
      remainOnExit: "off",
      agentLog: { kind: "active", logPath, displayPath: logPath },
    });
    execFileSync("tmux", argv);

    // `vi.waitFor` polls the assertion until it succeeds or the timeout
    // expires. Using it (instead of a hand-rolled `while (Date.now() < ...)`
    // loop) keeps the assertion unconditional, which satisfies the
    // jest/no-conditional-expect and jest/no-conditional-in-test rules.
    await vi.waitFor(
      () => {
        expect(readFileSync(logPath, "utf8")).toContain("hello-from-tmux-test");
      },
      { timeout: 5000, interval: 25 },
    );
  });

  // oxlint-disable-next-line jest/consistent-test-it -- project convention (.rules/common/testing.md) mandates `it`; oxlint's `consistent-test-it` rule doesn't recognize `describe.skipIf(...)` as a describe block and so misfires here.
  it("captures the shell exit code via trap when the launch chain exits", async () => {
    const logPath = join(sandbox, "TEST-2-20260517-150000.log");
    // A minimal launch-style command: install the trap, run a no-op step,
    // exit with a known non-zero code. Mirrors what buildLaunchCommand produces.
    const command = `trap 'echo "[groundcrew] exit=$?" >&2' EXIT && echo "[groundcrew] step: hello" >&2 && exit 42`;
    const argv = buildTmuxOpenArgv({
      sessionName,
      spec: {
        name: "TEST-2",
        cwd: sandbox,
        command,
      },
      remainOnExit: "off",
      agentLog: { kind: "active", logPath, displayPath: logPath },
    });
    execFileSync("tmux", argv);

    // vi.waitFor retries on any thrown assertion — both checks must succeed
    // in the same poll iteration or the loop continues until timeout.
    await vi.waitFor(
      () => {
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("[groundcrew] step: hello");
        expect(log).toContain("[groundcrew] exit=42");
        // Defend against regressions in the perl pipe-pane filter — if
        // timestamps stop appearing, the substrings above would still pass.
        expect(log).toMatch(/^\d{2}:\d{2}:\d{2} \[groundcrew\] step: hello/m);
      },
      { timeout: 5000, interval: 25 },
    );
  });

  // oxlint-disable-next-line jest/consistent-test-it -- project convention (.rules/common/testing.md) mandates `it`; oxlint's `consistent-test-it` rule doesn't recognize `describe.skipIf(...)` as a describe block and so misfires here.
  it("stops capturing pane output after the pipe-pane disable", async () => {
    const logPath = join(sandbox, "TEST-3-20260517-150000.log");
    // Simulate the buildLaunchCommand boundary: write a sentinel before the
    // disable, invoke the disable from inside the pane, then write a second
    // sentinel that should NOT appear in the log.
    const command = `echo "before-disable" && tmux pipe-pane -t "$TMUX_PANE" && echo "after-disable" && sleep 0.5`;
    const argv = buildTmuxOpenArgv({
      sessionName,
      spec: {
        name: "TEST-3",
        cwd: sandbox,
        command,
      },
      remainOnExit: "off",
      agentLog: { kind: "active", logPath, displayPath: logPath },
    });
    execFileSync("tmux", argv);

    // Wait for before-disable to land, then confirm after-disable never does
    // even after a generous flush window.
    await vi.waitFor(
      () => {
        expect(readFileSync(logPath, "utf8")).toContain("before-disable");
      },
      { timeout: 5000, interval: 25 },
    );
    // Give tmux a moment to process the disable AND any subsequent writes that
    // would have been captured if the disable hadn't worked.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("before-disable");
    expect(log).not.toContain("after-disable");
  });
});
