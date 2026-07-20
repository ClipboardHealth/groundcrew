/**
 * Translate a {@link SandboxPolicy} into the srt (Anthropic sandbox-runtime)
 * settings object and stage it on disk. This is the whole of the policy → srt
 * mapping; `wrap()` composes the CLI invocation around the staged file.
 *
 * The mapping, deny-by-default in one place:
 *
 * - **Writes are allow-only.** `writablePaths` become srt `allowWrite`; nothing
 *   else is writable, so a write outside the granted set is denied by omission
 *   (validated live under `sandbox-exec`: an out-of-scope `writeFile` returns
 *   `EPERM`). srt's `denyWrite` is left empty — the policy grants narrowly
 *   rather than granting broad and carving back out, so there is nothing to
 *   subtract.
 * - **Reads mask the home region, then re-open explicitly.** `denyRead` covers
 *   the user home (`/Users` on macOS; `/home` + `/root` + `/mnt` on Linux) so
 *   the wrapped process cannot read `~/.ssh`, `~/.aws`, shell history, or
 *   unrelated repos — the deny-by-default posture that makes this a sandbox.
 *   `allowRead` re-opens exactly `writablePaths`, `readOnlyPaths`, and the
 *   active Node runtime prefix (so a `#!/usr/bin/env node` agent/source still
 *   executes under the mask — srt's `allowRead` wins over `denyRead`). Non-home
 *   system directories (`/usr`, `/bin`, `/System`, `/private`, `/tmp`, …) stay
 *   readable because they are never masked: those are the "system defaults" the
 *   policy's `readOnlyPaths` adds to. Anything else a wrapped command needs to
 *   read under the home region is the caller's to list in `readOnlyPaths`.
 * - **Network is allow-only.** Each allowlist entry contributes its host to
 *   `allowedDomains`; an empty policy list yields an empty `allowedDomains`,
 *   which srt treats as deny-all egress (validated live: every request `EPERM`).
 *   Local binding and unix sockets stay off. srt matches egress by **host**, so
 *   a `host:port` entry keeps only the host (see {@link toAllowedDomain}).
 *
 * Fail-closed: the generated object is validated against srt's own schema before
 * it is returned. srt's `loadConfig` silently falls back to an unrestricted
 * default config on any parse failure, so a single malformed entry would run the
 * command unsandboxed — we throw here instead so the launch aborts loudly.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import type { SandboxPolicy } from "./types.js";

/**
 * The subset of srt's `SandboxRuntimeConfig` this module emits. Kept structural
 * (not imported from srt) so the staged JSON shape is owned here and asserted
 * directly in tests; it is validated against srt's runtime schema before use.
 */
export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    allowGitConfig: boolean;
  };
  allowPty: boolean;
}

export interface BuildSrtSettingsOptions {
  /** Defaults to `process.platform`. Injected in tests to exercise both masks. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.execPath`; its prefix is re-opened so Node runs under the mask. */
  nodeExecPath?: string;
}

/**
 * The home-region read mask for a platform: the deny-by-default baseline that
 * hides the user's private files. `/mnt` masks WSL's Windows drive mounts, whose
 * profile is otherwise readable from Linux.
 */
export function homeReadMask(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["/Users"] : ["/home", "/root", "/mnt"];
}

/**
 * The Node runtime prefix (`<execPath>/../..`), re-opened read-only so a wrapped
 * `#!/usr/bin/env node` command can execute even though the runtime lives under
 * the home mask (e.g. a version-managed install). Other interpreters a command
 * needs are the caller's to re-open via `readOnlyPaths`.
 */
export function nodeRuntimePrefix(nodeExecPath: string): string {
  return path.dirname(path.dirname(nodeExecPath));
}

/**
 * Reduce a policy network entry (`host` or `host:port`) to the host srt matches
 * on. srt's egress allowlist is host-level only — it has no port dimension — so
 * the port is dropped. Returns `undefined` for a blank entry.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function toAllowedDomain(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (trimmed === "") {
    return undefined;
  }
  const withPort = /^(?<host>.+):(?<port>\d+)$/u.exec(trimmed);
  return withPort?.groups?.["host"] ?? trimmed;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Build the srt settings object for a policy. Throws (fails closed) if the
 * result would not satisfy srt's own schema — for example a network entry srt
 * would reject — rather than emit settings srt silently ignores while running
 * the command unsandboxed.
 */
export function buildSrtSettings(
  policy: SandboxPolicy,
  options: BuildSrtSettingsOptions = {},
): SrtSettings {
  const platform = options.platform ?? process.platform;
  const nodeExecPath = options.nodeExecPath ?? process.execPath;

  const hosts = policy.network
    .map((entry) => toAllowedDomain(entry))
    .filter((host): host is string => host !== undefined);
  // srt has no port dimension, and loopback egress is governed by
  // `allowLocalBinding`, not `allowedDomains` (which rejects IP:port entries):
  // a loopback allowlist entry therefore enables local traffic as a whole,
  // and only non-loopback hosts ride the domain allowlist. Validated live on
  // macOS sandbox-exec (evidence: sandbox-lane bring-up).
  const allowedDomains = unique(hosts.filter((host) => !isLoopbackHost(host)));
  const allowLocalBinding = hosts.some((host) => isLoopbackHost(host));

  const allowRead = unique([
    nodeRuntimePrefix(nodeExecPath),
    ...policy.writablePaths,
    ...policy.readOnlyPaths,
  ]);
  const allowWrite = unique(policy.writablePaths);

  const settings: SrtSettings = {
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: homeReadMask(platform),
      allowRead,
      allowWrite,
      denyWrite: [],
      allowGitConfig: false,
    },
    allowPty: true,
  };

  const validation = SandboxRuntimeConfigSchema.safeParse(settings);
  if (!validation.success) {
    const detail = validation.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Generated srt settings failed validation (refusing to run unsandboxed): ${detail}`,
    );
  }
  return settings;
}

/** Short content hash of a settings object, used for a deterministic file name. */
export function settingsHash(settings: SrtSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
}

/**
 * Write the settings to a content-addressed path under the OS temp dir and
 * return it. Deterministic: identical policies stage the same file, so wrapping
 * the same command twice is idempotent. The seam stays "command in, command
 * out" — this side effect is the settings file srt requires.
 */
export function stageSettings(settings: SrtSettings, tmpDir: string = os.tmpdir()): string {
  const directory = path.join(tmpDir, "groundcrew-sandbox");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `srt-${settingsHash(settings)}.json`);
  writeFileSync(file, `${JSON.stringify(settings, undefined, 2)}\n`);
  return file;
}
