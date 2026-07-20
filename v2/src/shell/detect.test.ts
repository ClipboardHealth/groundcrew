import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "./config/schema.js";
import { DEFAULT_SOURCE_KIND, effectiveAgents, effectiveSources, onPath } from "./detect.js";

const base = (over: Partial<Config> = {}): Config => ({
  workspace: { baseDirectory: "/dev" },
  ...over,
});

describe("effectiveSources", () => {
  it("defaults to todo-txt when sources are omitted", () => {
    expect(effectiveSources(base())).toEqual([{ kind: DEFAULT_SOURCE_KIND }]);
  });

  it("returns the configured sources verbatim when present (never merged)", () => {
    const sources = [{ kind: "linear" }];
    expect(effectiveSources(base({ sources }))).toBe(sources);
  });
});

describe("effectiveAgents", () => {
  it("uses configured profiles when present, marking them not detected", () => {
    const config = base({ agents: { default: "scripted", profiles: { scripted: {} } } });
    const result = effectiveAgents({ config, pathValue: "" });
    expect(result.detected).toBe(false);
    expect(result.default).toBe("scripted");
    expect(Object.keys(result.profiles)).toEqual(["scripted"]);
  });

  it("detects presets on PATH when agents are omitted", () => {
    const detected = effectiveAgents({ config: base(), pathValue: "" });
    expect(detected.detected).toBe(true);
    expect(detected.default).toBeUndefined();
    expect(detected.profiles).toEqual({});
  });
});

describe("onPath", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds an executable on PATH and rejects a missing one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onpath-"));
    roots.push(dir);
    const exe = path.join(dir, "mytool");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    fs.chmodSync(exe, 0o755);
    expect(onPath({ name: "mytool", pathValue: dir })).toBe(true);
    expect(onPath({ name: "nope-xyz", pathValue: dir })).toBe(false);
  });
});
