import { z } from "zod";

import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import type { AdapterContext, AdapterDefinition } from "./adapterDefinition.ts";
import { buildSources, buildSourcesWith, sourcesFromConfig } from "./buildSources.ts";
import type { ResolvedConfig } from "./config.ts";
import type { TicketSource } from "./ticketSource.ts";
import { readEnvironmentVariable } from "./util.ts";

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

// ─────────────────────────────────────────────────────────────────────────
// Cross-source independence: a user with `linear.projects=[…]` and an
// explicit `sources=[{kind:"shell"}]` block must be able to construct
// both adapters even when no Linear API key is in env. The Linear
// adapter's eager `getLinearClient()` call used to crash buildSources
// on the missing key, which broke `crew doctor --ticket <shell-id>`
// and any other shell-only operation. These tests pin that behavior
// using the REAL production adapter registry (no spies, no fakes).
// ─────────────────────────────────────────────────────────────────────────

function makeMixedConfig(): ResolvedConfig {
  // Minimal ResolvedConfig with Linear projects configured AND an explicit
  // shell source. The Linear adapter's full type contract requires more
  // fields; we cast through `unknown` since the adapters only inspect
  // `globalConfig.linear.projects` and `globalConfig.workspace`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture; the linear adapter only reads linear.projects + workspace
  return {
    linear: {
      projects: [
        {
          projectSlug: "ai-strategy-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
    },
    sources: [
      {
        kind: "shell",
        name: "shell-test",
        commands: { fetch: "echo '[]'" },
      },
    ],
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
  } as unknown as ResolvedConfig;
}

describe(`${buildSources.name} — cross-source independence with no Linear API key`, () => {
  const originalGroundcrewKey = readEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
  const originalLinearKey = readEnvironmentVariable("LINEAR_API_KEY");

  beforeEach(() => {
    deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    deleteEnvironmentVariable("LINEAR_API_KEY");
  });

  afterEach(() => {
    if (originalGroundcrewKey === undefined) {
      deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", originalGroundcrewKey);
    }
    if (originalLinearKey === undefined) {
      deleteEnvironmentVariable("LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("LINEAR_API_KEY", originalLinearKey);
    }
  });

  it("constructs both Linear and shell sources without throwing", async () => {
    const config = makeMixedConfig();

    const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });

    expect(sources.map((s) => s.name)).toStrictEqual(["linear", "shell-test"]);
  });

  it("a shell source can fetch() successfully even when Linear has no API key", async () => {
    const config = makeMixedConfig();
    const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
    const shell = sources.find((s) => s.name === "shell-test");

    // oxlint-disable-next-line typescript/no-non-null-assertion -- buildSources asserted both above
    const issues = await shell!.fetch();

    expect(issues).toStrictEqual([]);
  });

  it("the Linear source defers its credential check until a method is invoked", async () => {
    const config = makeMixedConfig();
    const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
    const linear = sources.find((s) => s.name === "linear");

    // oxlint-disable-next-line typescript/no-non-null-assertion -- buildSources asserted above
    await expect(linear!.verify()).rejects.toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
  });
});

describe(sourcesFromConfig, () => {
  it("prepends an implicit linear source when config.linear.projects has entries", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [{ slugId: "eng" }] },
      sources: [{ kind: "shell", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    const result = sourcesFromConfig(config);

    expect(result).toStrictEqual([{ kind: "linear" }, { kind: "shell", command: ["./fetch.sh"] }]);
  });

  it("omits the implicit linear source when config.linear.projects is empty", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [] },
      sources: [{ kind: "shell", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    const result = sourcesFromConfig(config);

    expect(result).toStrictEqual([{ kind: "shell", command: ["./fetch.sh"] }]);
  });

  it("returns just the implicit linear source when config.sources is empty", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [{ slugId: "eng" }] },
      sources: [],
    } as unknown as ResolvedConfig;

    const result = sourcesFromConfig(config);

    expect(result).toStrictEqual([{ kind: "linear" }]);
  });

  it("throws when an explicit source with kind 'linear' collides with the implicit one", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [{ slugId: "eng" }] },
      sources: [{ kind: "linear" }],
    } as unknown as ResolvedConfig;

    expect(() => sourcesFromConfig(config)).toThrow(/resolves to source name "linear"/);
  });

  it("throws when an explicit source with name 'linear' collides with the implicit one", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [{ slugId: "eng" }] },
      sources: [{ kind: "shell", name: "linear", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    expect(() => sourcesFromConfig(config)).toThrow(/resolves to source name "linear"/);
  });

  it("does not throw when an explicit source has a distinct name even with linear.projects set", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [{ slugId: "eng" }] },
      sources: [{ kind: "shell", name: "jira", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([
      { kind: "linear" },
      { kind: "shell", name: "jira", command: ["./fetch.sh"] },
    ]);
  });

  it("does not throw when an explicit source with kind 'linear' is declared but linear.projects is empty", () => {
    // No implicit synthesis → no collision possible. (The user has chosen to
    // wire Linear via the explicit sources path instead.)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads linear.projects and sources; unused fields are irrelevant
    const config = {
      linear: { projects: [] },
      sources: [{ kind: "linear" }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([{ kind: "linear" }]);
  });
});
