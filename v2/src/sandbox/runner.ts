/**
 * Locate the srt CLI and compose the shell invocation that runs a command under
 * it. srt ships as a pinned dependency; its `dist/cli.js` carries a
 * `#!/usr/bin/env node` shebang and is marked executable, so it is referenced
 * directly (like the v1 launcher) rather than through a `node` prefix.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

/** Platforms srt confines here. Windows needs a separate install step; unsupported. */
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);

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
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["srt"];
  if (binEntry === undefined) {
    throw new Error("@anthropic-ai/sandbox-runtime package.json is missing the `srt` bin entry.");
  }
  return path.resolve(path.dirname(packageJsonPath), binEntry);
}

/** Whether srt is usable on this host: platform supported and the CLI resolvable on disk. */
export function isRunnerAvailable(options: { platform?: NodeJS.Platform } = {}): boolean {
  if (!isPlatformSupported(options.platform)) {
    return false;
  }
  try {
    return existsSync(resolveSrtCli());
  } catch {
    return false;
  }
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
