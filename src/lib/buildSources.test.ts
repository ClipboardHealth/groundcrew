import { z } from "zod";

import type { AdapterContext, AdapterDefinition } from "./adapterDefinition.ts";
import { buildSources, buildSourcesWith } from "./buildSources.ts";
import type { ResolvedConfig } from "./config.ts";
import type { TicketSource } from "./ticketSource.ts";

const fakeContext: AdapterContext = {
  // Tests don't need a real ResolvedConfig — fakeAdapter ignores its context arg.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fake adapter does not inspect globalConfig
  globalConfig: {} as ResolvedConfig,
};

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
    value: z.string(),
  });
  return {
    kind,
    configSchema: schema,
    create: (cfg) => {
      const name =
        typeof cfg === "object" && cfg !== null && "name" in cfg && typeof cfg.name === "string"
          ? cfg.name
          : kind;
      return emptySource(name);
    },
  };
}

describe(buildSourcesWith, () => {
  it("dispatches a SourceConfig[] to TicketSource[] via the registry", () => {
    const registry = { foo: fakeAdapter("foo"), bar: fakeAdapter("bar") };
    const sources = buildSourcesWith(
      registry,
      [
        { kind: "foo", value: "v1" },
        { kind: "bar", value: "v2", name: "bar-renamed" },
      ],
      fakeContext,
    );
    expect(sources.map((s) => s.name)).toStrictEqual(["foo", "bar-renamed"]);
  });

  it("rejects an unknown kind with a message listing the registered kinds", () => {
    const registry = { foo: fakeAdapter("foo"), bar: fakeAdapter("bar") };
    expect(() =>
      buildSourcesWith(registry, [{ kind: "unknown", value: "x" }], fakeContext),
    ).toThrow(/Unknown source kind.*unknown.*foo.*bar/);
  });

  it("reports '(none)' for the empty-registry case in the unknown-kind message", () => {
    expect(() => buildSourcesWith({}, [{ kind: "anything" }], fakeContext)).toThrow(
      /Unknown source kind.*anything.*\(none\)/,
    );
  });

  it("rejects a config that is missing a string kind field", () => {
    expect(() => buildSourcesWith({}, [{ value: "x" }], fakeContext)).toThrow(/.+/);
  });

  it("rejects a malformed config field via Zod parse", () => {
    const registry = { foo: fakeAdapter("foo") };
    // missing required `value` field
    expect(() => buildSourcesWith(registry, [{ kind: "foo" }], fakeContext)).toThrow(/.+/);
  });

  it("returns an empty array for an empty config list", () => {
    const registry = { foo: fakeAdapter("foo") };
    expect(buildSourcesWith(registry, [], fakeContext)).toStrictEqual([]);
  });
});

describe(buildSources, () => {
  it("awaits the production adapterRegistry and dispatches", async () => {
    // The production registry contains the built-in linear and shell adapters;
    // dispatching an empty config list is a no-op that still exercises the
    // production async path through the registry.
    const sources = await buildSources([], fakeContext);
    expect(sources).toStrictEqual([]);
  });
});
