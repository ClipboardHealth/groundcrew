import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  composeSrtInvocation,
  isPlatformSupported,
  isRunnerAvailable,
  resolveSrtCli,
  shellSingleQuote,
} from "./runner.js";

describe(isPlatformSupported, () => {
  it("supports macOS and Linux, not Windows", () => {
    expect(isPlatformSupported("darwin")).toBe(true);
    expect(isPlatformSupported("linux")).toBe(true);
    expect(isPlatformSupported("win32")).toBe(false);
  });
});

describe(resolveSrtCli, () => {
  it("resolves the srt CLI to an existing executable file", () => {
    const cli = resolveSrtCli();

    expect(cli.endsWith("cli.js")).toBe(true);
    expect(existsSync(cli)).toBe(true);
  });

  it("throws an actionable error when the dependency cannot be resolved", () => {
    expect(() => resolveSrtCli("file:///nonexistent/module.js")).toThrow(/could not be resolved/u);
  });
});

describe(isRunnerAvailable, () => {
  it("is true on a supported platform where the CLI resolves", () => {
    expect(isRunnerAvailable({ platform: "darwin" })).toBe(true);
  });

  it("is false on an unsupported platform without touching the filesystem", () => {
    expect(isRunnerAvailable({ platform: "win32" })).toBe(false);
  });
});

describe(shellSingleQuote, () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellSingleQuote("/usr/bin/srt")).toBe("'/usr/bin/srt'");
  });

  it("escapes embedded single quotes so the shell sees one literal argument", () => {
    expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe(composeSrtInvocation, () => {
  it("emits `srt --settings <file> -c <command>` with every part quoted", () => {
    const actual = composeSrtInvocation({
      srtCli: "/n/srt/cli.js",
      settingsFile: "/tmp/groundcrew-sandbox/srt-abc.json",
      command: "claude --model opus",
    });

    expect(actual).toBe(
      "'/n/srt/cli.js' --settings '/tmp/groundcrew-sandbox/srt-abc.json' -c 'claude --model opus'",
    );
  });

  it("keeps a command containing quotes intact as a single -c argument", () => {
    const actual = composeSrtInvocation({
      srtCli: "/n/srt/cli.js",
      settingsFile: "/tmp/s.json",
      command: `sh -c 'echo hi'`,
    });

    expect(actual).toBe(
      `'/n/srt/cli.js' --settings '/tmp/s.json' -c 'sh -c '\\''echo hi'\\'''`,
    );
  });
});
