/**
 * Locate the srt CLI and compose the shell invocation that runs a command under
 * it. srt ships as a pinned dependency; its `dist/cli.js` carries a
 * `#!/usr/bin/env node` shebang and is marked executable, so it is referenced
 * directly (like the v1 launcher) rather than through a `node` prefix.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

/** Platforms srt confines here. Windows needs a separate install step; unsupported. */
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);

/**
 * srt's Linux backend (bubblewrap) shells out to these at runtime; the CLI file
 * existing on disk says nothing about them. `crew doctor` would otherwise report
 * a green srt check on a Linux host that then fails every launch with an opaque
 * srt error. Ported from v1 `host.ts`/`doctor.ts`: bubblewrap ships the `bwrap`
 * binary; srt proxies egress through `socat` and searches with ripgrep (`rg`).
 * macOS uses `sandbox-exec` (in the base system) and needs none of these.
 */
const LINUX_RUNTIME_DEPENDENCIES: ReadonlyArray<{ readonly binary: string; readonly label: string }> = [
  { binary: "bwrap", label: "bubblewrap" },
  { binary: "socat", label: "socat" },
  { binary: "rg", label: "ripgrep (rg)" },
];

/** Whether srt can confine a command on this platform (macOS `sandbox-exec`, Linux bubblewrap). */
export function isPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

/**
 * Resolve the absolute path to srt's CLI via Node module resolution, reading the
 * package's `bin` field so the path survives version bumps that move the entry
 * point. Throws with an actionable message when the dependency is missing.
 *
 * @param baseUrl - Test seam; production callers omit it so resolution is
 *   relative to this module.
 */
export function resolveSrtCli(baseUrl: string = import.meta.url): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(baseUrl).resolve("@anthropic-ai/sandbox-runtime/package.json");
  } catch (error) {
    throw new Error(
      "@anthropic-ai/sandbox-runtime (the srt sandbox runner) could not be resolved. " +
        "Reinstall dependencies with `npm ci`.",
      { cause: error },
    );
  }
  const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin =
    typeof manifest === "object" && manifest !== null && "bin" in manifest
      ? manifest.bin
      : undefined;
  const binEntry =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? recordString(bin, "srt")
        : undefined;
  if (binEntry === undefined) {
    throw new Error("@anthropic-ai/sandbox-runtime package.json is missing the `srt` bin entry.");
  }
  return path.resolve(path.dirname(packageJsonPath), binEntry);
}

/** srt runner availability plus, on failure, an actionable reason for `crew doctor`. */
export interface RunnerAvailability {
  readonly available: boolean;
  /** Set only when `available` is false: what is missing and how to fix it. */
  readonly detail?: string;
}

/** Test seam / production defaults for the host probes {@link describeRunner} runs. */
export interface DescribeRunnerOptions {
  platform?: NodeJS.Platform;
  /** PATH to scan for the Linux runtime deps; defaults to `process.env.PATH`. */
  pathValue?: string;
  /** Injected binary-on-PATH predicate (tests); defaults to a real PATH scan. */
  hasBinary?: (binary: string) => boolean;
}

/**
 * Whether srt is usable on this host and, when not, why. Beyond platform support
 * and the CLI resolving on disk, this probes the Linux runtime dependencies srt's
 * bubblewrap backend shells out to (bwrap/socat/rg) — checked only on Linux,
 * where their absence otherwise surfaces as an opaque per-launch srt error rather
 * than a doctor failure. The macOS path is unchanged (no runtime deps).
 */
export function describeRunner(options: DescribeRunnerOptions = {}): RunnerAvailability {
  const platform = options.platform ?? process.platform;
  if (!isPlatformSupported(platform)) {
    return { available: false, detail: "the srt sandbox runner requires macOS or Linux/WSL" };
  }

  try {
    if (!existsSync(resolveSrtCli())) {
      return { available: false, detail: srtCliMissingDetail() };
    }
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }

  if (platform === "linux") {
    const hasBinary =
      options.hasBinary ??
      ((binary: string): boolean => binaryOnPath(binary, options.pathValue ?? process.env["PATH"] ?? ""));
    const missing = LINUX_RUNTIME_DEPENDENCIES.filter((dep) => !hasBinary(dep.binary)).map(
      (dep) => dep.label,
    );
    if (missing.length > 0) {
      return { available: false, detail: linuxDepsHint(missing) };
    }
  }

  return { available: true };
}

/** Whether srt is usable on this host: platform, CLI on disk, and (Linux) runtime deps. */
export function isRunnerAvailable(options: DescribeRunnerOptions = {}): boolean {
  return describeRunner(options).available;
}

function srtCliMissingDetail(): string {
  return "the srt sandbox runner (@anthropic-ai/sandbox-runtime) is not installed; run `npm ci`";
}

function linuxDepsHint(missing: readonly string[]): string {
  return (
    `the srt runner on Linux requires ${missing.join(", ")} on PATH ` +
    "(Debian/Ubuntu: `apt install bubblewrap socat ripgrep`; on Ubuntu 24.04+ also " +
    "`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` to allow unprivileged user namespaces)"
  );
}

/** Whether an executable named `binary` is found on `pathValue`. */
function binaryOnPath(binary: string, pathValue: string): boolean {
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === "") {
      continue;
    }
    try {
      accessSync(path.join(directory, binary), constants.X_OK);
      return true;
    } catch {
      // not here; keep scanning
    }
  }
  return false;
}

/** POSIX single-quote a string so a shell passes it through as one literal argument. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Compose the shell command that runs `command` under srt with `settingsFile`.
 * srt's `-c` mode runs the string like `sh -c`, which is exactly the seam's
 * "command in, command out": the original command line is handed through
 * verbatim, confined by the settings file.
 */
export function composeSrtInvocation(input: {
  srtCli: string;
  settingsFile: string;
  command: string;
}): string {
  return [
    shellSingleQuote(input.srtCli),
    "--settings",
    shellSingleQuote(input.settingsFile),
    "-c",
    shellSingleQuote(input.command),
  ].join(" ");
}

function recordString(value: object, key: string): string | undefined {
  const entry: unknown = Reflect.get(value, key);
  return typeof entry === "string" ? entry : undefined;
}
