import * as fs from "node:fs";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { configure } from "./bindings.js";
import { withScenario } from "./scenario.js";

interface GeneratedConfig {
  agents: { default?: string; profiles: Record<string, unknown> };
  sources: Array<{ name: string; agent?: string }>;
}

function readConfig(configPath: string): GeneratedConfig {
  return parse(fs.readFileSync(configPath, "utf8")) as GeneratedConfig;
}

function only<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) {
    throw new Error("expected at least one item");
  }

  return first;
}

describe("configure agent routing", () => {
  it("defaults agents.default and each source's agent to scripted", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      const config = readConfig(crew.configPath);

      expect(config.agents.default).toBe("scripted");
      expect(only(config.sources).agent).toBe("scripted");
    });
  });

  it("omits agents.default when defaultAgent is null", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({ scenario, config: { defaultAgent: null } });
      const config = readConfig(crew.configPath);

      expect(config.agents.default).toBeUndefined();
      expect(config.agents.profiles).toBeDefined();
    });
  });

  it("omits a source's agent key when SourceFixture.agent is null (unrouted, DISPATCH-05)", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({ scenario, config: { sources: [{ agent: null }] } });
      const config = readConfig(crew.configPath);

      const source = only(config.sources);
      expect(source.agent).toBeUndefined();
      expect(source.name).toBe("fixture");
    });
  });

  it("still honors explicit agent overrides", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({
        scenario,
        config: { defaultAgent: "claude", sources: [{ agent: "codex" }] },
      });
      const config = readConfig(crew.configPath);

      expect(config.agents.default).toBe("claude");
      expect(only(config.sources).agent).toBe("codex");
    });
  });
});
