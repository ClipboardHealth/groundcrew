import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { AdapterDefinition } from "../adapterDefinition.ts";
import type { TicketSource } from "../ticketSource.ts";
import {
  adapterRegistry,
  type AdapterLoader,
  buildRegistry,
  buildSourceConfigSchema,
  listAdapterDirectories,
} from "./registry.ts";

function emptySource(name: string): TicketSource {
  return {
    name,
    verify: vi.fn<() => Promise<void>>().mockResolvedValue(),
    fetch: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires a value for non-void return type
    resolveOne: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    markInProgress: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
}

function fakeAdapter(kind: string): AdapterDefinition {
  const schema = z.object({
    kind: z.literal(kind),
    name: z.string().optional(),
  });
  return {
    kind,
    configSchema: schema,
    create: () => emptySource(kind),
  };
}

const passthroughLoader: AdapterLoader = async (name) => fakeAdapter(name);

describe(buildRegistry, () => {
  it("loads adapters whose directory name matches their kind", async () => {
    const good = fakeAdapter("good");
    const loader: AdapterLoader = vi.fn<AdapterLoader>().mockResolvedValue(good);
    const registry = await buildRegistry(["good"], loader);
    expect(Object.keys(registry)).toStrictEqual(["good"]);
    expect(registry["good"]).toBe(good);
    expect(loader).toHaveBeenCalledWith("good");
  });

  it("loads multiple adapters in directory order", async () => {
    const registry = await buildRegistry(["a", "b"], passthroughLoader);
    expect(Object.keys(registry)).toStrictEqual(["a", "b"]);
  });

  it("throws when an adapter's kind disagrees with the directory name", async () => {
    const mismatched: AdapterDefinition = fakeAdapter("DIFFERENT");
    const loader: AdapterLoader = vi.fn<AdapterLoader>().mockResolvedValue(mismatched);
    await expect(buildRegistry(["mismatched"], loader)).rejects.toThrow(
      /directory mismatch.*mismatched.*DIFFERENT/,
    );
  });

  it("rejects duplicate kinds (defence in depth)", async () => {
    // Two directory entries that both resolve to the same kind. Belt-and-suspenders
    // given the directory-name === kind invariant makes this structurally hard.
    await expect(buildRegistry(["x", "x"], passthroughLoader)).rejects.toThrow(
      /Duplicate adapter kind/,
    );
  });
});

describe(buildSourceConfigSchema, () => {
  it("returns z.never() for an empty registry", () => {
    const schema = buildSourceConfigSchema({});
    expect(() => schema.parse({ kind: "anything" })).toThrow(/.+/);
  });

  it("returns the adapter's schema directly when the registry has exactly one", () => {
    const schema = buildSourceConfigSchema({ only: fakeAdapter("only") });
    expect(() => schema.parse({ kind: "only" })).not.toThrow();
    expect(() => schema.parse({ kind: "other" })).toThrow(/.+/);
  });

  it("returns a discriminated union when the registry has multiple adapters", () => {
    const schema = buildSourceConfigSchema({
      a: fakeAdapter("a"),
      b: fakeAdapter("b"),
    });
    expect(() => schema.parse({ kind: "a" })).not.toThrow();
    expect(() => schema.parse({ kind: "b" })).not.toThrow();
    expect(() => schema.parse({ kind: "unknown" })).toThrow(/.+/);
  });
});

describe(listAdapterDirectories, () => {
  it("returns the names of subdirectories, skipping files", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "list-adapter-dirs-"));
    try {
      mkdirSync(path.join(tempDir, "alpha"));
      mkdirSync(path.join(tempDir, "beta"));
      writeFileSync(path.join(tempDir, "not-a-dir.txt"), "ignored");
      expect(listAdapterDirectories(tempDir).toSorted()).toStrictEqual(["alpha", "beta"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns an empty array for a directory with no subdirectories", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "list-adapter-dirs-empty-"));
    try {
      expect(listAdapterDirectories(tempDir)).toStrictEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("adapterRegistry production IIFE", () => {
  it("loads the built-in linear and shell adapters from src/lib/adapters/", async () => {
    const registry = await adapterRegistry;
    expect(Object.keys(registry).toSorted()).toStrictEqual(["linear", "shell"]);
    expect(registry["linear"]?.kind).toBe("linear");
    expect(registry["shell"]?.kind).toBe("shell");
  });

  it("each loaded adapter exposes a Zod configSchema and a create function", async () => {
    const registry = await adapterRegistry;
    for (const adapter of Object.values(registry)) {
      expect(adapter.configSchema).toBeDefined();
      expectTypeOf(adapter.create).toBeFunction();
    }
  });
});
