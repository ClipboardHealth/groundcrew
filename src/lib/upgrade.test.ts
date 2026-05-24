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
  parseVersion,
  readUpgradeCheckCache,
  writeUpgradeCheckCache,
} from "./upgrade.ts";

type FetcherFn = ComputeUpgradeNudgeOptions["fetcher"];

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

  it("treats two distinct prereleases of the same numeric as equal (coarse comparison)", () => {
    expect(compareVersions("3.1.8-beta.1", "3.1.8-beta.2")).toBe(0);
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
      "https://registry.npmjs.org/@scope/pkg/latest",
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
      "https://npm.mirror.example/@scope/pkg/latest",
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

  it("returns 'fresh' when the entry is within the TTL", () => {
    writeFileSync(cachePath, JSON.stringify({ latest: "3.1.8", fetchedAt: 1000 }));
    const result = readUpgradeCheckCache(cachePath, { now: () => 1500, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "fresh", entry: { latest: "3.1.8", fetchedAt: 1000 } });
  });

  it("returns 'stale' when the entry is older than the TTL", () => {
    writeFileSync(cachePath, JSON.stringify({ latest: "3.1.8", fetchedAt: 1000 }));
    const result = readUpgradeCheckCache(cachePath, { now: () => 5000, ttlMs: 1000 });
    expect(result).toStrictEqual({ kind: "stale", entry: { latest: "3.1.8", fetchedAt: 1000 } });
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
    writeUpgradeCheckCache(cachePath, { latest: "3.2.0", fetchedAt: 42 });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 42,
    });
  });

  it("overwrites an existing cache file", () => {
    const cachePath = join(cacheDir, "upgrade-check.json");
    writeUpgradeCheckCache(cachePath, { latest: "3.1.8", fetchedAt: 1 });
    writeUpgradeCheckCache(cachePath, { latest: "3.2.0", fetchedAt: 2 });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 2,
    });
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
    writeFileSync(cachePath, JSON.stringify({ latest: "9.9.9", fetchedAt: 1_000_000 }));
    const result = await computeUpgradeNudge(
      baseOptions({ currentVersion: "1.0.0", noUpgradeCheck: true }),
    );
    expect(result).toBeUndefined();
  });

  it("returns a nudge using a fresh cache entry when newer", async () => {
    writeFileSync(cachePath, JSON.stringify({ latest: "3.2.0", fetchedAt: 1_000_000 }));
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8" }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
  });

  it("returns undefined when fresh cache equals current", async () => {
    writeFileSync(cachePath, JSON.stringify({ latest: "3.1.8", fetchedAt: 1_000_000 }));
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8" }));
    expect(result).toBeUndefined();
  });

  it("fetches when cache is stale, writes new cache, returns nudge", async () => {
    const stale = 1_000_000 - 100 * 60 * 60 * 1000; // 100h ago, beyond 6h TTL
    writeFileSync(cachePath, JSON.stringify({ latest: "3.1.8", fetchedAt: stale }));
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(fetcher).toHaveBeenCalledWith("@clipboard-health/groundcrew", {
      timeoutMs: 300,
      registry: undefined,
    });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 1_000_000,
    });
  });

  it("falls back to stale cache entry when fetch fails", async () => {
    const stale = 1_000_000 - 100 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify({ latest: "3.2.0", fetchedAt: stale }));
    const fetcher = vi.fn<FetcherFn>().mockRejectedValueOnce(new Error("network down"));
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: stale,
    });
  });

  it("returns undefined when fetch fails and no cache exists", async () => {
    const fetcher = vi.fn<FetcherFn>().mockRejectedValueOnce(new Error("network down"));
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBeUndefined();
  });

  it("fetches when cache is missing and writes the cache on success", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValueOnce("3.2.0");
    const result = await computeUpgradeNudge(baseOptions({ currentVersion: "3.1.8", fetcher }));
    expect(result).toBe("[crew] 3.2.0 available — run `crew upgrade` (you have 3.1.8)");
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 1_000_000,
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
