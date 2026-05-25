import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareVersions,
  composeNudgeMessage,
  type ComputeUpgradeNudgeOptions,
  computeUpgradeNudge,
  defaultUpgradeCheckCachePath,
  fetchLatestVersion,
  normalizeRegistry,
  parseVersion,
  primeUpgradeCheckCache,
  readUpgradeCheckCache,
  recordUpgradeCheckFailure,
  type UpgradeCheckCacheEntry,
  type UpgradeCheckFailureCacheEntry,
  writeUpgradeCheckCache,
} from "./upgrade.ts";

type FetcherFn = ComputeUpgradeNudgeOptions["fetcher"];
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

function cacheEntry(overrides: Partial<UpgradeCheckCacheEntry> = {}): UpgradeCheckCacheEntry {
  return {
    latest: "3.1.8",
    fetchedAt: 1000,
    registry: DEFAULT_REGISTRY,
    ...overrides,
  };
}

function failureCacheEntry(
  overrides: Partial<UpgradeCheckFailureCacheEntry> = {},
): UpgradeCheckFailureCacheEntry {
  return {
    status: "failure",
    fetchedAt: 1000,
    registry: DEFAULT_REGISTRY,
    ...overrides,
  };
}

function writeCacheEntry(path: string, overrides: Partial<UpgradeCheckCacheEntry> = {}): void {
  writeUpgradeCheckCache(path, cacheEntry(overrides));
}

function readCacheEntry(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe(parseVersion, () => {
  it("parses major.minor.patch", () => {
    expect(parseVersion("3.1.8")).toStrictEqual({
      major: 3,
      minor: 1,
      patch: 8,
      prerelease: undefined,
    });
  });

  it("captures the prerelease suffix", () => {
    expect(parseVersion("3.1.8-beta.1")).toStrictEqual({
      major: 3,
      minor: 1,
      patch: 8,
      prerelease: "beta.1",
    });
  });

  it("strips build metadata after the +", () => {
    expect(parseVersion("3.1.8+sha.abc")).toStrictEqual({
      major: 3,
      minor: 1,
      patch: 8,
      prerelease: undefined,
    });
  });

  it("captures prerelease and strips build metadata together", () => {
    expect(parseVersion("3.1.8-beta+sha.abc")).toStrictEqual({
      major: 3,
      minor: 1,
      patch: 8,
      prerelease: "beta",
    });
  });

  it("throws on missing components", () => {
    expect(() => parseVersion("3.1")).toThrow(/invalid version/i);
  });

  it("throws on non-numeric components", () => {
    expect(() => parseVersion("3.x.8")).toThrow(/invalid version/i);
  });

  it("throws on empty string", () => {
    expect(() => parseVersion("")).toThrow(/invalid version/i);
  });

  it("throws on leading-zero numeric components", () => {
    expect(() => parseVersion("01.2.3")).toThrow(/invalid version/i);
  });

  it("throws on empty prerelease identifiers", () => {
    expect(() => parseVersion("1.2.3-alpha..1")).toThrow(/invalid version/i);
  });

  it("throws on empty build identifiers", () => {
    expect(() => parseVersion("1.2.3+build..1")).toThrow(/invalid version/i);
  });
});

describe(compareVersions, () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("3.1.8", "3.1.8")).toBe(0);
  });

  it("returns -1 when first is older by patch", () => {
    expect(compareVersions("3.1.7", "3.1.8")).toBe(-1);
  });

  it("returns 1 when first is newer by patch", () => {
    expect(compareVersions("3.1.9", "3.1.8")).toBe(1);
  });

  it("returns 1 when first is newer by minor (minor outranks patch)", () => {
    expect(compareVersions("3.2.0", "3.1.99")).toBe(1);
  });

  it("returns 1 when first is newer by major (major outranks minor)", () => {
    expect(compareVersions("4.0.0", "3.99.99")).toBe(1);
  });

  it("ranks a prerelease lower than the stable of the same numeric", () => {
    expect(compareVersions("3.1.8-beta.1", "3.1.8")).toBe(-1);
  });

  it("ranks the stable higher than a prerelease of the same numeric", () => {
    expect(compareVersions("3.1.8", "3.1.8-beta.1")).toBe(1);
  });

  it("treats two identical prerelease strings as equal", () => {
    expect(compareVersions("3.1.8-beta.1", "3.1.8-beta.1")).toBe(0);
  });

  it("orders prerelease identifiers numerically", () => {
    expect(compareVersions("3.1.8-beta.1", "3.1.8-beta.2")).toBe(-1);
  });

  it("orders larger numeric prerelease identifiers higher", () => {
    expect(compareVersions("3.1.8-beta.2", "3.1.8-beta.1")).toBe(1);
  });

  it("orders numeric prerelease identifiers without losing precision", () => {
    expect(compareVersions("3.1.8-beta.9007199254740993", "3.1.8-beta.9007199254740992")).toBe(1);
  });

  it("orders numeric prerelease identifiers by length before lexical order", () => {
    expect(compareVersions("3.1.8-beta.10", "3.1.8-beta.9")).toBe(1);
  });

  it("orders shorter numeric prerelease identifiers lower by length", () => {
    expect(compareVersions("3.1.8-beta.9", "3.1.8-beta.10")).toBe(-1);
  });

  it("orders non-numeric prerelease identifiers lexically", () => {
    expect(compareVersions("3.1.8-alpha", "3.1.8-beta")).toBe(-1);
  });

  it("orders later lexical prerelease identifiers higher", () => {
    expect(compareVersions("3.1.8-beta", "3.1.8-alpha")).toBe(1);
  });

  it("ranks numeric prerelease identifiers lower than non-numeric ones", () => {
    expect(compareVersions("3.1.8-1", "3.1.8-alpha")).toBe(-1);
  });

  it("ranks non-numeric prerelease identifiers higher than numeric ones", () => {
    expect(compareVersions("3.1.8-alpha", "3.1.8-1")).toBe(1);
  });

  it("ranks a longer prerelease higher when all preceding identifiers match", () => {
    expect(compareVersions("3.1.8-beta.1.1", "3.1.8-beta.1")).toBe(1);
  });

  it("ranks a shorter prerelease lower when all preceding identifiers match", () => {
    expect(compareVersions("3.1.8-beta.1", "3.1.8-beta.1.1")).toBe(-1);
  });
});

describe(fetchLatestVersion, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the version field from a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ version: "3.1.8" })),
    );
    const result = await fetchLatestVersion("@clipboard-health/groundcrew", { timeoutMs: 1000 });
    expect(result).toBe("3.1.8");
  });

  it("hits the default npm registry when none is supplied", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: "1.0.0" }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchLatestVersion("@scope/pkg", { timeoutMs: 1000 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@scope%2Fpkg/latest",
      expect.any(Object),
    );
  });

  it("uses a custom registry and strips a trailing slash", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: "1.0.0" }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchLatestVersion("@scope/pkg", {
      timeoutMs: 1000,
      registry: "https://npm.mirror.example/",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://npm.mirror.example/@scope%2Fpkg/latest",
      expect.any(Object),
    );
  });

  it("throws when the registry responds with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("nope", { status: 503 })),
    );
    await expect(fetchLatestVersion("@scope/pkg", { timeoutMs: 1000 })).rejects.toThrow(/503/);
  });

  it("wraps network failures with a registry-context message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND")),
    );
    await expect(fetchLatestVersion("@scope/pkg", { timeoutMs: 1000 })).rejects.toThrow(
      /registry request failed/,
    );
  });

  it("throws when the timeout elapses before the registry responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    await expect(fetchLatestVersion("@scope/pkg", { timeoutMs: 5 })).rejects.toThrow(
      /registry request failed/,
    );
  });

  it("keeps the timeout active while reading the response body", async () => {
    let abortBody: ((error: Error) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          abortBody?.(new Error("body aborted"));
        });
        const response = new Response("{}", { status: 200 });
        vi.spyOn(response, "json").mockImplementation(
          async () =>
            await new Promise<unknown>((_resolve, reject) => {
              abortBody = reject;
            }),
        );
        return response;
      }),
    );
    await expect(fetchLatestVersion("@scope/pkg", { timeoutMs: 5 })).rejects.toThrow(
      /body aborted/,
    );
  });

  it("throws when the response body lacks a version field entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ name: "x" })),
    );
    await expect(fetchLatestVersion("@scope/pkg", { timeoutMs: 1000 })).rejects.toThrow(/version/);
  });

  it("throws when the version field is present but not a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ version: 123 })),
    );
    await expect(fetchLatestVersion("@scope/pkg", { timeoutMs: 1000 })).rejects.toThrow(/version/);
  });
});

describe(normalizeRegistry, () => {
  it("returns the default npm registry when no registry is configured", () => {
    const input: { registry?: string } = {};
    expect(normalizeRegistry(input.registry)).toBe(DEFAULT_REGISTRY);
  });

  it("strips one trailing slash from a configured registry", () => {
    expect(normalizeRegistry("https://npm.mirror.example/")).toBe("https://npm.mirror.example");
  });
});

describe(defaultUpgradeCheckCachePath, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses XDG_CACHE_HOME when set", () => {
    vi.stubEnv("XDG_CACHE_HOME", "/var/cache/example");
    expect(defaultUpgradeCheckCachePath()).toBe("/var/cache/example/groundcrew/upgrade-check.json");
  });

  it("falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- exercises the unset-env fallback
    vi.stubEnv("XDG_CACHE_HOME", undefined);
    expect(defaultUpgradeCheckCachePath()).toBe(
      join(homedir(), ".cache", "groundcrew", "upgrade-check.json"),
    );
  });

  it("falls back to ~/.cache when XDG_CACHE_HOME is empty", () => {
    vi.stubEnv("XDG_CACHE_HOME", "");
    expect(defaultUpgradeCheckCachePath()).toBe(
      join(homedir(), ".cache", "groundcrew", "upgrade-check.json"),
    );
  });
});

describe(readUpgradeCheckCache, () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "groundcrew-upgrade-cache-"));
    cachePath = join(cacheDir, "upgrade-check.json");
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns 'missing' when the file does not exist", () => {
    const result = readUpgradeCheckCache(cachePath, { now: () => 0, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'missing' when the file contains invalid JSON", () => {
    writeFileSync(cachePath, "{not json");
    const result = readUpgradeCheckCache(cachePath, { now: () => 0, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'missing' when the JSON parses to null", () => {
    writeFileSync(cachePath, "null");
    const result = readUpgradeCheckCache(cachePath, { now: () => 0, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'missing' when the JSON is not an object", () => {
    writeFileSync(cachePath, "5");
    const result = readUpgradeCheckCache(cachePath, { now: () => 0, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'missing' when the object lacks required fields", () => {
    writeFileSync(cachePath, JSON.stringify({ latest: "3.1.8" }));
    const result = readUpgradeCheckCache(cachePath, { now: () => 0, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'missing' when the cache entry lacks the registry field", () => {
    writeFileSync(cachePath, JSON.stringify({ latest: "3.1.8", fetchedAt: 1000 }));
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'missing' when a non-failure cache entry lacks latest", () => {
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1000, registry: DEFAULT_REGISTRY }));
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'fresh' when the entry is within the TTL", () => {
    writeCacheEntry(cachePath);
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({
      kind: "fresh",
      entry: cacheEntry(),
    });
  });

  it("returns 'stale' when the entry is older than the TTL", () => {
    writeCacheEntry(cachePath);
    const result = readUpgradeCheckCache(cachePath, { now: () => 5000, ttlMs: 1000 });
    expect(result).toStrictEqual({
      kind: "stale",
      entry: cacheEntry(),
    });
  });

  it("returns 'missing' when the cache entry was fetched from a different registry", () => {
    writeCacheEntry(cachePath, { latest: "9.9.9", registry: "https://npm.mirror.example" });
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });

  it("returns 'recentFailure' for a fresh failed check marker", () => {
    const entry = failureCacheEntry();
    writeUpgradeCheckCache(cachePath, entry);
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "recentFailure", entry });
  });

  it("preserves latest on a fresh failed check marker", () => {
    const entry = failureCacheEntry({ latest: "3.2.0" });
    writeUpgradeCheckCache(cachePath, entry);
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "recentFailure", entry });
  });

  it("returns 'missing' for a stale failed check marker", () => {
    writeUpgradeCheckCache(cachePath, failureCacheEntry());
    const result = readUpgradeCheckCache(cachePath, { now: () => 5000, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "missing" });
  });
});

describe(writeUpgradeCheckCache, () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "groundcrew-upgrade-cache-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("creates intermediate directories and writes the entry", () => {
    const cachePath = join(cacheDir, "nested", "upgrade-check.json");
    const entry = cacheEntry({ latest: "3.2.0", fetchedAt: 42 });
    writeUpgradeCheckCache(cachePath, entry);
    expect(readCacheEntry(cachePath)).toStrictEqual(entry);
  });

  it("overwrites an existing cache file", () => {
    const cachePath = join(cacheDir, "upgrade-check.json");
    writeUpgradeCheckCache(cachePath, cacheEntry({ fetchedAt: 1 }));
    const entry = cacheEntry({
      latest: "3.2.0",
      fetchedAt: 2,
      registry: "https://npm.mirror.example",
    });
    writeUpgradeCheckCache(cachePath, entry);
    expect(readCacheEntry(cachePath)).toStrictEqual(entry);
  });

  it("writes a failed check marker", () => {
    const cachePath = join(cacheDir, "upgrade-check.json");
    const entry = failureCacheEntry({ fetchedAt: 2 });
    writeUpgradeCheckCache(cachePath, entry);
    expect(readCacheEntry(cachePath)).toStrictEqual(entry);
  });
});

describe(primeUpgradeCheckCache, () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "groundcrew-upgrade-cache-"));
    cachePath = join(cacheDir, "upgrade-check.json");
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("writes a normalized registry cache entry", () => {
    primeUpgradeCheckCache({
      path: cachePath,
      latest: "3.2.0",
      now: () => 42,
      registry: "https://npm.mirror.example/",
    });
    expect(readCacheEntry(cachePath)).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 42,
      registry: "https://npm.mirror.example",
    });
  });

  it("swallows cache write failures", () => {
    const blocker = join(cacheDir, "blocker");
    writeFileSync(blocker, "");
    expect(() => {
      primeUpgradeCheckCache({
        path: join(blocker, "cache.json"),
        latest: "3.2.0",
        now: () => 42,
      });
    }).not.toThrow();
  });
});

describe(recordUpgradeCheckFailure, () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "groundcrew-upgrade-cache-"));
    cachePath = join(cacheDir, "upgrade-check.json");
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("writes a normalized registry failure marker", () => {
    recordUpgradeCheckFailure({
      path: cachePath,
      now: () => 42,
      registry: "https://npm.mirror.example/",
    });
    expect(readCacheEntry(cachePath)).toStrictEqual({
      status: "failure",
      fetchedAt: 42,
      registry: "https://npm.mirror.example",
    });
  });

  it("preserves a stale latest version while recording a failure marker", () => {
    recordUpgradeCheckFailure({
      path: cachePath,
      latest: "3.2.0",
      now: () => 42,
    });
    expect(readCacheEntry(cachePath)).toStrictEqual({
      status: "failure",
      latest: "3.2.0",
      fetchedAt: 42,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("swallows cache write failures", () => {
    const blocker = join(cacheDir, "blocker");
    writeFileSync(blocker, "");
    expect(() => {
      recordUpgradeCheckFailure({
        path: join(blocker, "cache.json"),
        now: () => 42,
      });
    }).not.toThrow();
  });
});

describe(composeNudgeMessage, () => {
  it("returns a one-line message when latest is newer than current", () => {
    expect(composeNudgeMessage("3.1.8", "3.2.0")).toBe(
      "[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)",
    );
  });

  it("returns undefined when current equals latest", () => {
    expect(composeNudgeMessage("3.1.8", "3.1.8")).toBeUndefined();
  });

  it("returns undefined when current is newer than latest", () => {
    expect(composeNudgeMessage("3.2.0", "3.1.8")).toBeUndefined();
  });
});

describe(computeUpgradeNudge, () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "groundcrew-upgrade-nudge-"));
    cachePath = join(cacheDir, "upgrade-check.json");
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function baseOptions(overrides: {
    currentVersion: string;
    fetcher?: FetcherFn;
    noUpgradeCheck?: boolean;
    now?: () => number;
  }): ComputeUpgradeNudgeOptions {
    return {
      currentVersion: overrides.currentVersion,
      packageName: "@clipboard-health/groundcrew",
      cachePath,
      ttlMs: 6 * 60 * 60 * 1000,
      fetchTimeoutMs: 300,
      noUpgradeCheck: overrides.noUpgradeCheck ?? false,
      now: overrides.now ?? (() => 1_000_000),
      fetcher:
        overrides.fetcher ??
        (async () => {
          throw new Error("fetcher should not have been called");
        }),
    };
  }

  it("returns undefined when noUpgradeCheck is true (env opt-out)", async () => {
    writeCacheEntry(cachePath, { latest: "9.9.9", fetchedAt: 1_000_000 });
    const result = await computeUpgradeNudge(
      baseOptions({ currentVersion: "1.0.0", noUpgradeCheck: true }),
    );
    expect(result).toBeUndefined();
  });

  it("returns a nudge using a fresh cache entry when newer", async () => {
    writeCacheEntry(cachePath, { latest: "3.2.0", fetchedAt: 1_000_000 });
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8" }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
  });

  it("returns undefined when fresh cache equals current", async () => {
    writeCacheEntry(cachePath, { fetchedAt: 1_000_000 });
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8" }));
    expect(result).toBeUndefined();
  });

  it("fetches when cache is stale, writes new cache, returns nudge", async () => {
    const stale = 1_000_000 - 100 * 60 * 60 * 1000; // 100h ago, beyond 6h TTL
    writeCacheEntry(cachePath, { fetchedAt: stale });
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(fetcher).toHaveBeenCalledWith("@clipboard-health/groundcrew", {
      timeoutMs: 300,
      registry: undefined,
    });
    expect(readCacheEntry(cachePath)).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 1_000_000,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("falls back to stale cache entry when fetch fails", async () => {
    const stale = 1_000_000 - 100 * 60 * 60 * 1000;
    writeCacheEntry(cachePath, { latest: "3.2.0", fetchedAt: stale });
    const fetcher = vi.fn<FetcherFn>().mockRejectedValueOnce(new Error("network down"));
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(readCacheEntry(cachePath)).toStrictEqual({
      status: "failure",
      latest: "3.2.0",
      fetchedAt: 1_000_000,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("returns undefined when fetch fails and no cache exists", async () => {
    const fetcher = vi.fn<FetcherFn>().mockRejectedValueOnce(new Error("network down"));
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBeUndefined();
    expect(readCacheEntry(cachePath)).toStrictEqual({
      status: "failure",
      fetchedAt: 1_000_000,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("skips fetching during the failed-check backoff window", async () => {
    writeUpgradeCheckCache(cachePath, failureCacheEntry({ fetchedAt: 1_000_000 }));
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses a failed-check marker with latest during the backoff window", async () => {
    writeUpgradeCheckCache(cachePath, failureCacheEntry({ latest: "3.2.0", fetchedAt: 1_000_000 }));
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("9.9.9");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches again after a failed-check marker expires", async () => {
    const stale = 1_000_000 - 100 * 60 * 60 * 1000;
    writeUpgradeCheckCache(cachePath, failureCacheEntry({ fetchedAt: stale }));
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(readCacheEntry(cachePath)).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 1_000_000,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("fetches when cache is missing and writes the cache on success", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(readCacheEntry(cachePath)).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 1_000_000,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("ignores a fresh cache entry from a different registry and refreshes it", async () => {
    writeCacheEntry(cachePath, {
      latest: "9.9.9",
      fetchedAt: 1_000_000,
      registry: "https://npm.mirror.example",
    });
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge({
      ...baseOptions({ currentVersion: "3.1.8", fetcher }),
      registry: "https://registry.npmjs.org/",
    });
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(fetcher).toHaveBeenCalledWith("@clipboard-health/groundcrew", {
      timeoutMs: 300,
      registry: "https://registry.npmjs.org/",
    });
    expect(readCacheEntry(cachePath)).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 1_000_000,
      registry: DEFAULT_REGISTRY,
    });
  });

  it("returns the fresh nudge even when cache write throws", async () => {
    // Point cachePath under a regular file so mkdirSync inside writeUpgradeCheckCache throws.
    const blocker = join(cacheDir, "blocker");
    writeFileSync(blocker, "");
    const unreachableCachePath = join(blocker, "cache.json");
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge({
      ...baseOptions({ currentVersion: "3.1.8", fetcher }),
      cachePath: unreachableCachePath,
    });
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
  });
});
