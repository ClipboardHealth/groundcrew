import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  composeSrtInvocation,
  describeRunner,
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

  it("probes the Linux runtime deps and is available when all are on PATH", () => {
    expect(isRunnerAvailable({ platform: "linux", hasBinary: () => true })).toBe(true);
  });

  it("is false on Linux when a runtime dep is missing", () => {
    const present = new Set(["bwrap", "rg"]);
    expect(
      isRunnerAvailable({ platform: "linux", hasBinary: (binary) => present.has(binary) }),
    ).toBe(false);
  });

  it("does not probe runtime deps on macOS (sandbox-exec needs none)", () => {
    let probed = false;
    expect(
      isRunnerAvailable({
        platform: "darwin",
        hasBinary: () => {
          probed = true;
          return false;
        },
      }),
    ).toBe(true);
    expect(probed).toBe(false);
  });
});

describe(describeRunner, () => {
  it("names the missing Linux deps and the apt/apparmor remediation", () => {
    const present = new Set(["bwrap"]);
    const result = describeRunner({
      platform: "linux",
      hasBinary: (binary) => present.has(binary),
    });

    expect(result.available).toBe(false);
    // The "requires ..." clause lists only the missing deps (bubblewrap present).
    expect(result.detail).toMatch(/requires socat, ripgrep \(rg\) on PATH/u);
    expect(result.detail).toContain("apt install bubblewrap socat ripgrep");
    expect(result.detail).toContain("apparmor_restrict_unprivileged_userns");
  });

  it("explains an unsupported platform", () => {
    const result = describeRunner({ platform: "win32" });

    expect(result.available).toBe(false);
    expect(result.detail).toContain("macOS or Linux");
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
