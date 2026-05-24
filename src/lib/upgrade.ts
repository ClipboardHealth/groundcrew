import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readEnvironmentVariable } from "./util.ts";

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/;

export function parseVersion(version: string): Version {
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(`invalid version: ${JSON.stringify(version)}`);
  }
  return {
    // oxlint-disable typescript/no-non-null-assertion -- VERSION_RE guarantees groups 1–3 on match; group 4 is optional.
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    // oxlint-enable typescript/no-non-null-assertion
    prerelease: match[4],
  };
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
  }
  // Numeric parts equal. Per SemVer 11.3, a stable version outranks any
  // prerelease of the same numeric. Two prereleases of the same numeric are
  // treated as equal — we deliberately don't implement full per-identifier
  // SemVer ordering, since the registry's `latest` dist-tag never points at
  // a prerelease in npm convention.
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === undefined) {
    return 1;
  }
  if (right.prerelease === undefined) {
    return -1;
  }
  return 0;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

interface FetchOptions {
  timeoutMs: number;
  registry?: string | undefined;
}

export async function fetchLatestVersion(
  packageName: string,
  options: FetchOptions,
): Promise<string> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/$/, "");
  const url = `${registry}/${packageName}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    throw new Error(`registry request failed: ${String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`registry returned ${response.status} for ${url}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("version" in body)) {
    throw new TypeError(`registry response missing 'version' field`);
  }
  const { version } = body;
  if (typeof version !== "string") {
    throw new TypeError(`registry response 'version' field is not a string`);
  }
  return version;
}

export interface UpgradeCheckCacheEntry {
  latest: string;
  fetchedAt: number;
}

export type UpgradeCheckCacheResult =
  | { kind: "missing" }
  | { kind: "fresh"; entry: UpgradeCheckCacheEntry }
  | { kind: "stale"; entry: UpgradeCheckCacheEntry };

export function defaultUpgradeCheckCachePath(): string {
  const base = readEnvironmentVariable("XDG_CACHE_HOME") ?? join(homedir(), ".cache");
  return join(base, "groundcrew", "upgrade-check.json");
}

function parseCacheEntry(value: unknown): UpgradeCheckCacheEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as { latest?: unknown; fetchedAt?: unknown };
  if (typeof candidate.latest !== "string" || typeof candidate.fetchedAt !== "number") {
    return undefined;
  }
  return { latest: candidate.latest, fetchedAt: candidate.fetchedAt };
}

export function readUpgradeCheckCache(
  path: string,
  options: { now: () => number; ttlMs: number },
): UpgradeCheckCacheResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "missing" };
  }
  const entry = parseCacheEntry(parsed);
  if (!entry) {
    return { kind: "missing" };
  }
  const ageMs = options.now() - entry.fetchedAt;
  return ageMs >= options.ttlMs ? { kind: "stale", entry } : { kind: "fresh", entry };
}

export function writeUpgradeCheckCache(path: string, entry: UpgradeCheckCacheEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry));
}

export function composeNudgeMessage(current: string, latest: string): string | undefined {
  if (compareVersions(current, latest) >= 0) {
    return undefined;
  }
  return `[crew] ${latest} available — run \`crew upgrade\` (you have ${current})`;
}

type VersionFetcher = (packageName: string, options: FetchOptions) => Promise<string>;

export interface ComputeUpgradeNudgeOptions {
  currentVersion: string;
  packageName: string;
  cachePath: string;
  ttlMs: number;
  fetchTimeoutMs: number;
  registry?: string | undefined;
  noUpgradeCheck: boolean;
  now: () => number;
  fetcher: VersionFetcher;
}

export async function computeUpgradeNudge(
  options: ComputeUpgradeNudgeOptions,
): Promise<string | undefined> {
  if (options.noUpgradeCheck) {
    return undefined;
  }
  const cacheResult = readUpgradeCheckCache(options.cachePath, {
    now: options.now,
    ttlMs: options.ttlMs,
  });
  if (cacheResult.kind === "fresh") {
    return composeNudgeMessage(options.currentVersion, cacheResult.entry.latest);
  }
  try {
    const latest = await options.fetcher(options.packageName, {
      timeoutMs: options.fetchTimeoutMs,
      registry: options.registry,
    });
    try {
      writeUpgradeCheckCache(options.cachePath, { latest, fetchedAt: options.now() });
    } catch {
      // Best-effort cache priming; don't lose a freshly-fetched value on disk error.
    }
    return composeNudgeMessage(options.currentVersion, latest);
  } catch {
    if (cacheResult.kind === "stale") {
      return composeNudgeMessage(options.currentVersion, cacheResult.entry.latest);
    }
    return undefined;
  }
}
