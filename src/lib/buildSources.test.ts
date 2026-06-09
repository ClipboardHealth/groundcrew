import { z } from "zod";

import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import type { AdapterContext, AdapterDefinition } from "./adapterDefinition.ts";
import {
  buildSources,
  buildSourcesWith,
  isLinearEnabled,
  sourcesFromConfig,
} from "./buildSources.ts";
import type { ResolvedConfig } from "./config.ts";
import type { MarkInReviewResult, TaskSource } from "./taskSource.ts";
import { readEnvironmentVariable } from "./util.ts";

const fakeContext: AdapterContext = {
  // Tests don't need a real ResolvedConfig — fakeAdapter ignores its context arg.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fake adapter does not inspect globalConfig
  globalConfig: {} as ResolvedConfig,
};

function emptySource(name: string): TaskSource {
  return {
    name,
    verify: vi.fn<() => Promise<void>>().mockResolvedValue(),
    listTasks: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    getTask: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    fetch: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires a value for non-void return type
    resolveOne: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    markInProgress: vi.fn<() => Promise<void>>().mockResolvedValue(),
    markInReview: vi
      .fn<() => Promise<MarkInReviewResult>>()
      .mockResolvedValue({ outcome: "applied" }),
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
  it("dispatches a SourceConfig[] to TaskSource[] via the registry", () => {
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
// Cross-source independence: a user with an explicit
// `sources=[{kind:"shell"}]` block must be able to construct both adapters
// even when no Linear API key is in env. The Linear adapter's eager
// `getLinearClient()` call used to crash buildSources on the missing key,
// which broke `crew doctor --task <shell-id>` and any other shell-only
// operation. These tests pin that behavior using the REAL production adapter
// registry (no spies, no fakes).
// ─────────────────────────────────────────────────────────────────────────

function makeMixedConfig(): ResolvedConfig {
  // Minimal ResolvedConfig with explicit Linear and shell sources.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture; the linear adapter only reads workspace.knownRepositories
  return {
    sources: [
      { kind: "linear" },
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

  it("builds only the shell source when Linear is disabled via the sentinel, with no key", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture; only the shell source is constructed
    const config = {
      sources: [
        { kind: "linear", enabled: false },
        { kind: "shell", name: "plans", commands: { fetch: "echo '[]'" } },
      ],
      workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
    } as unknown as ResolvedConfig;

    const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });

    // No Linear adapter is built and nothing throws on the missing key.
    expect(sources.map((s) => s.name)).toStrictEqual(["plans"]);

    const shell = sources.find((s) => s.name === "plans");
    // oxlint-disable-next-line typescript/no-non-null-assertion -- asserted above
    await expect(shell!.fetch()).resolves.toStrictEqual([]);
  });
});

describe(sourcesFromConfig, () => {
  it("returns only the explicit sources when no Linear entry is present", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "shell", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    const result = sourcesFromConfig(config);

    expect(result).toStrictEqual([{ kind: "shell", command: ["./fetch.sh"] }]);
  });

  it("returns empty when config.sources is empty", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = { sources: [] } as unknown as ResolvedConfig;

    const result = sourcesFromConfig(config);

    expect(result).toStrictEqual([]);
  });

  it("returns the explicit linear source as-is", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "linear", name: "linear" }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([{ kind: "linear", name: "linear" }]);
  });

  it("returns a linear source declared with a custom name as-is", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "linear", name: "custom-linear" }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([{ kind: "linear", name: "custom-linear" }]);
  });

  it("returns a shell source named 'linear' as-is", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "shell", name: "linear", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([
      { kind: "shell", name: "linear", command: ["./fetch.sh"] },
    ]);
  });

  it("returns only the shell source when no Linear entry is present", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "shell", name: "jira", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([
      { kind: "shell", name: "jira", command: ["./fetch.sh"] },
    ]);
  });

  it("drops Linear entirely when the user disables it via { kind: 'linear', enabled: false }", () => {
    // The disabled linear entry still counts as "explicit linear" (so the
    // implicit source is suppressed) AND is filtered out of the kept list,
    // leaving only the shell source — no Linear adapter is ever constructed.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [
        { kind: "linear", enabled: false },
        { kind: "shell", name: "plans", command: ["./fetch.sh"] },
      ],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([
      { kind: "shell", name: "plans", command: ["./fetch.sh"] },
    ]);
  });

  it("keeps an explicit Linear source when enabled: true", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "linear", enabled: true }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([{ kind: "linear", enabled: true }]);
  });

  it("drops a disabled linear entry even when it is the only source, leaving no sources", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "linear", enabled: false }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([]);
  });

  it("drops a disabled non-linear source and returns only the remaining enabled ones", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [
        { kind: "shell", name: "plans", enabled: false, command: ["./fetch.sh"] },
        { kind: "shell", name: "jira", command: ["./fetch.sh"] },
      ],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([
      { kind: "shell", name: "jira", command: ["./fetch.sh"] },
    ]);
  });

  it("returns empty when a shell source named 'linear' is disabled and no other sources exist", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourcesFromConfig only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "shell", name: "linear", enabled: false, command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    expect(sourcesFromConfig(config)).toStrictEqual([]);
  });
});

describe(isLinearEnabled, () => {
  it("is false when no sources are declared", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isLinearEnabled only reads sources; unused fields are irrelevant
    const config = { sources: [] } as unknown as ResolvedConfig;

    expect(isLinearEnabled(config)).toBe(false);
  });

  it("is false when Linear is opted out via { kind: 'linear', enabled: false }", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isLinearEnabled only reads sources; unused fields are irrelevant
    const config = {
      sources: [
        { kind: "linear", enabled: false },
        { kind: "shell", name: "plans", command: ["./fetch.sh"] },
      ],
    } as unknown as ResolvedConfig;

    expect(isLinearEnabled(config)).toBe(false);
  });

  it("is true for an explicitly declared, enabled Linear source", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isLinearEnabled only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "linear", name: "custom-linear" }],
    } as unknown as ResolvedConfig;

    expect(isLinearEnabled(config)).toBe(true);
  });

  it("is false when a shell source merely named 'linear' is the only source", () => {
    // A source that is Linear only by *name* is not a real Linear adapter, so
    // Linear is not enabled even though it occupies the Linear slot.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isLinearEnabled only reads sources; unused fields are irrelevant
    const config = {
      sources: [{ kind: "shell", name: "linear", command: ["./fetch.sh"] }],
    } as unknown as ResolvedConfig;

    expect(isLinearEnabled(config)).toBe(false);
  });
});
