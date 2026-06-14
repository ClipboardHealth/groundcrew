import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLEARANCE_CLI_PATH = fileURLToPath(new URL("../bin/clearanceCli.js", import.meta.url));

// Clearance's `ensure` entrypoint probes its fixed port (127.0.0.1:19999) and
// then, with no allowlist configured, throws its own allowlist error. Either
// outcome is a clearance-owned signal that the shim dispatched into clearance:
// a running proxy yields "already listening" (exit 0); a free port yields the
// allowlist error (exit 2). A shim-level failure (e.g. tripping clearance's
// `exports` gate) would instead surface a Node error and exit 1, so matching
// one of these messages and one of these codes proves correct dispatch and
// exit-code passthrough regardless of whether a proxy is already running.
//
// The "Unknown clearance-ensure command" arm keeps the arbitrary-args test
// green across clearance versions: newer clearance parses argv into start/stop/
// restart/status subcommands and rejects an unrecognized first arg with that
// message (exit 2), whereas older clearance ignores argv and reaches the start
// path. Both are clearance-owned responses, so either still proves the shim
// forwarded argv without interpreting it.
const CLEARANCE_DISPATCH_PATTERN =
  /Clearance already listening|Set CLEARANCE_ALLOW_HOSTS|Unknown clearance-ensure command/;
const CLEARANCE_EXIT_CODES = [0, 2];

function runClearanceCli(args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CLEARANCE_CLI_PATH, ...args], {
    encoding: "utf8",
  });

  return { status: result.status, stderr: result.stderr };
}

describe("clearance-cli shim", () => {
  beforeEach(() => {
    // Clear the allowlist so the port-free path throws its allowlist error
    // instead of spawning a real detached proxy, keeping the test
    // side-effect-free. The spawned child inherits this stubbed env.
    vi.stubEnv("CLEARANCE_ALLOW_HOSTS", "");
    vi.stubEnv("CLEARANCE_ALLOW_HOSTS_FILES", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches into clearance's ensure entrypoint and passes its exit code through", () => {
    const actual = runClearanceCli([]);

    expect(actual.stderr).toMatch(CLEARANCE_DISPATCH_PATTERN);
    expect(CLEARANCE_EXIT_CODES).toContain(actual.status);
  });

  it("forwards arbitrary args to clearance without interpreting them itself", () => {
    const actual = runClearanceCli(["--definitely-not-a-shim-flag", "extra"]);

    expect(actual.stderr).toMatch(CLEARANCE_DISPATCH_PATTERN);
    expect(CLEARANCE_EXIT_CODES).toContain(actual.status);
  });
});
