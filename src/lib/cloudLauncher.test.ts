import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CloudLaunchError,
  type CloudProcessResult,
  type CloudProcessRunner,
  launchCloudSession,
  parseCloudLaunchOutput,
  queueCloudMessage,
  runCloudProcess,
  scriptInvocation,
  stripTerminalNoise,
} from "./cloudLauncher.ts";
import { shellSingleQuote } from "./shell.ts";

const SESSION_ID = "session_01FG5BTFfKdTVvxpu7wMe3p5";
const SESSION_URL = `https://claude.ai/code/${SESSION_ID}?from=cli&m=0`;
const PROMPT = `it's "$HOME" \`whoami\`\nsecond line`;
const CLOUD_LAUNCH_TIMEOUT_MS = 90_000;
const ESC = String.fromCodePoint(27);

const CLOUD_OUTPUT = [
  "Created cloud session: Fix the thing",
  `View: ${SESSION_URL}`,
  `Resume with: claude --teleport ${SESSION_ID}`,
].join("\n");

const NON_TTY_ERROR = "Error: --cloud requires an interactive terminal.";

function decorate(text: string): string {
  return text
    .split("\n")
    .map((line) => `${ESC}[2K${ESC}[1G${line}\r`)
    .join("\n");
}

function recordingRunner(result: CloudProcessResult): {
  run: CloudProcessRunner;
  calls: Parameters<CloudProcessRunner>[0][];
} {
  const calls: Parameters<CloudProcessRunner>[0][] = [];
  return {
    calls,
    run: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

describe(stripTerminalNoise, () => {
  it("removes ANSI colour/cursor escapes and carriage returns", () => {
    const raw = `${ESC}[31mred${ESC}[0m${ESC}[2K${ESC}[1G line\r\n${ESC}[?25lnext\r\n`;

    expect(stripTerminalNoise(raw)).toBe("red line\nnext\n");
  });
});

describe(parseCloudLaunchOutput, () => {
  it("extracts session id and url", () => {
    const raw = decorate(CLOUD_OUTPUT);

    expect(parseCloudLaunchOutput(raw)).toStrictEqual({ sessionId: SESSION_ID, url: SESSION_URL });
  });

  it("returns undefined without a View line", () => {
    expect(parseCloudLaunchOutput(decorate(NON_TTY_ERROR))).toBeUndefined();
  });
});

describe(scriptInvocation, () => {
  const argv = ["claude", "--cloud", PROMPT];

  it("passes argv straight through on darwin", () => {
    expect(scriptInvocation("darwin", argv)).toStrictEqual({
      command: "script",
      args: ["-q", "/dev/null", "claude", "--cloud", PROMPT],
    });
  });

  it("uses a single quoted command string on linux", () => {
    const invocation = scriptInvocation("linux", argv);

    expect(invocation).toStrictEqual({
      command: "script",
      args: ["-qec", argv.map(shellSingleQuote).join(" "), "/dev/null"],
    });
  });

  it("round-trips a nasty prompt through sh on linux", () => {
    const [, shellCommand] = scriptInvocation("linux", ["printf", "%s", PROMPT]).args;

    expect(execFileSync("sh", ["-c", shellCommand ?? ""], { encoding: "utf8" })).toBe(PROMPT);
  });
});

describe(launchCloudSession, () => {
  it("returns the session on a successful run", async () => {
    const { run, calls } = recordingRunner({ exitCode: 0, output: decorate(CLOUD_OUTPUT) });

    const session = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      platform: "darwin",
      run,
    });

    expect(session).toStrictEqual({ sessionId: SESSION_ID, url: SESSION_URL });
    expect(calls).toStrictEqual([
      {
        command: "script",
        args: ["-q", "/dev/null", "claude", "--cloud", PROMPT],
        cwd: "/work/repo",
        timeoutMs: CLOUD_LAUNCH_TIMEOUT_MS,
        signal: undefined,
      },
    ]);
  });

  it("builds the script invocation for the current platform by default", async () => {
    const { run, calls } = recordingRunner({ exitCode: 0, output: CLOUD_OUTPUT });

    await launchCloudSession({ cwd: "/work/repo", prompt: PROMPT, run });

    expect(calls[0]).toMatchObject({
      ...scriptInvocation(process.platform, ["claude", "--cloud", PROMPT]),
    });
  });

  it("throws CloudLaunchError with the stripped output on a non-zero exit", async () => {
    const { run } = recordingRunner({ exitCode: 1, output: decorate(NON_TTY_ERROR) });

    const error: unknown = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      platform: "darwin",
      run,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudLaunchError);
    expect(error).toHaveProperty("message", expect.stringContaining("exited with code 1"));
    expect(error).toHaveProperty("output", NON_TTY_ERROR);
  });

  it("throws CloudLaunchError when no session url is printed", async () => {
    const { run } = recordingRunner({ exitCode: 0, output: decorate(NON_TTY_ERROR) });

    const error: unknown = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      platform: "darwin",
      run,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudLaunchError);
    expect(error).toHaveProperty("message", expect.stringContaining("did not print a session URL"));
    expect(error).toHaveProperty("message", expect.stringContaining(NON_TTY_ERROR));
  });

  it("returns the session when the run timed out after printing the View line", async () => {
    const { run } = recordingRunner({
      exitCode: 1,
      output: decorate(CLOUD_OUTPUT),
      timedOut: true,
    });

    const session = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      platform: "darwin",
      run,
    });

    expect(session).toStrictEqual({ sessionId: SESSION_ID, url: SESSION_URL });
  });

  it("throws CloudLaunchError when the run timed out before printing a session URL", async () => {
    const { run } = recordingRunner({ exitCode: 1, output: "Thinking...", timedOut: true });

    const error: unknown = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      platform: "darwin",
      run,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudLaunchError);
    expect(error).toHaveProperty("message", expect.stringContaining("timed out"));
    expect(error).toHaveProperty("output", "Thinking...");
  });

  it("truncates the error detail to 2000 characters, keeping the end", async () => {
    const { run } = recordingRunner({ exitCode: 1, output: `${"x".repeat(2500)}THE-END` });

    const error: unknown = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      platform: "darwin",
      run,
    }).catch((caught: unknown) => caught);

    expect(error).toHaveProperty("output", `${"x".repeat(2000 - "THE-END".length)}THE-END`);
  });

  it("refuses to start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const error: unknown = await launchCloudSession({
      cwd: "/work/repo",
      prompt: PROMPT,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudLaunchError);
    expect(error).toHaveProperty("message", expect.stringContaining("was aborted"));
  });
});

describe(runCloudProcess, () => {
  it("resolves with the exit code and the combined output", async () => {
    const result = await runCloudProcess({
      command: "sh",
      args: ["-c", "printf out; printf err 1>&2; exit 3"],
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("treats a signal-killed child as a failed exit", async () => {
    const result = await runCloudProcess({
      command: "sh",
      args: ["-c", "kill -9 $$"],
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(1);
  });

  it("kills the child and resolves as timed out with the output collected so far", async () => {
    const result = await runCloudProcess({
      command: "sh",
      args: ["-c", "printf partial; exec sleep 30"],
      cwd: tmpdir(),
      timeoutMs: 200,
    });

    expect(result).toStrictEqual({ exitCode: 1, output: "partial", timedOut: true });
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cloud-launcher-pid-"));
    try {
      const pidFile = join(directory, "child.pid");
      const result = await runCloudProcess({
        command: "sh",
        args: ["-c", `printf %s $$ > '${pidFile}'; trap "" TERM; exec sleep 30`],
        cwd: tmpdir(),
        timeoutMs: 500,
      });
      const childPid = Number(readFileSync(pidFile, "utf8"));

      expect(result.timedOut).toBe(true);
      expect(() => {
        process.kill(childPid, 0);
      }).toThrow("ESRCH");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("kills the child and rejects when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);

    const error: unknown = await runCloudProcess({
      command: "sh",
      args: ["-c", "exec sleep 30"],
      cwd: tmpdir(),
      timeoutMs: 10_000,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudLaunchError);
    expect(error).toHaveProperty("message", expect.stringContaining("was aborted"));
  });

  it("rejects with CloudLaunchError when the command cannot start", async () => {
    const error: unknown = await runCloudProcess({
      command: join(tmpdir(), "no-such-binary-for-cloud-launcher"),
      args: [],
      cwd: tmpdir(),
      timeoutMs: 10_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudLaunchError);
    expect(error).toHaveProperty("message", expect.stringContaining("failed to start"));
  });
});

describe(queueCloudMessage, () => {
  it("runs claude -p <msg> --cloud <id> --output-format json and resolves on ok", async () => {
    const calls: { command: string; args: readonly string[]; cwd: string | undefined }[] = [];

    await queueCloudMessage({
      sessionId: SESSION_ID,
      message: PROMPT,
      cwd: "/work/repo",
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return '{"ok":true,"session_id":"s","url":"u"}';
      },
    });

    expect(calls).toStrictEqual([
      {
        command: "claude",
        args: ["-p", PROMPT, "--cloud", SESSION_ID, "--output-format", "json"],
        cwd: "/work/repo",
      },
    ]);
  });

  it("throws when ok is not true", async () => {
    await expect(
      queueCloudMessage({
        sessionId: SESSION_ID,
        message: "hi",
        run: async () => '{"ok":false}',
      }),
    ).rejects.toThrow("did not confirm");
  });

  it("throws on unparsable JSON", async () => {
    await expect(
      queueCloudMessage({
        sessionId: SESSION_ID,
        message: "hi",
        run: async () => "not json",
      }),
    ).rejects.toThrow("unparsable JSON");
  });

  describe("with the default runner", () => {
    let fakeBinDirectory: string;

    beforeEach(() => {
      fakeBinDirectory = mkdtempSync(join(tmpdir(), "cloud-launcher-fake-claude-"));
      const argsFile = join(fakeBinDirectory, "args.txt");
      writeFileSync(
        join(fakeBinDirectory, "claude"),
        `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\nprintf '{"ok":true}\\n'\n`,
      );
      chmodSync(join(fakeBinDirectory, "claude"), 0o755);
      vi.stubEnv("PATH", [fakeBinDirectory, process.env["PATH"]].join(":"));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(fakeBinDirectory, { recursive: true, force: true });
    });

    it("passes the arguments through a fake claude binary", async () => {
      await queueCloudMessage({ sessionId: SESSION_ID, message: PROMPT, cwd: fakeBinDirectory });

      const recordedArgs = readFileSync(join(fakeBinDirectory, "args.txt"), "utf8").split("\0");

      expect(recordedArgs.slice(0, 6)).toStrictEqual([
        "-p",
        PROMPT,
        "--cloud",
        SESSION_ID,
        "--output-format",
        "json",
      ]);
    });

    it("runs in the current directory when no cwd is given", async () => {
      await queueCloudMessage({ sessionId: SESSION_ID, message: "hi" });

      expect(readFileSync(join(fakeBinDirectory, "args.txt"), "utf8")).toContain("--cloud");
    });
  });
});
