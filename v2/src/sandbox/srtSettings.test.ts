import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxPolicy } from "./index.js";
import {
  buildSrtSettings,
  homeReadMask,
  nodeRuntimePrefix,
  settingsHash,
  stageSettings,
  toAllowedDomain,
} from "./srtSettings.js";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { writablePaths: [], readOnlyPaths: [], network: [], ...overrides };
}

const linuxOptions = {
  platform: "linux" as NodeJS.Platform,
  nodeExecPath: "/home/dev/.nvm/versions/node/v24/bin/node",
};

describe(buildSrtSettings, () => {
  it("maps writablePaths to allow writes (denyWrite empty when none carved out)", () => {
    const actual = buildSrtSettings(
      policy({ writablePaths: ["/work/ws", "/state/scratch"] }),
      linuxOptions,
    );

    expect(actual.filesystem.allowWrite).toStrictEqual(["/work/ws", "/state/scratch"]);
    expect(actual.filesystem.denyWrite).toStrictEqual([]);
  });

  it("maps denyWritePaths to srt denyWrite (carve-outs under a broad grant)", () => {
    const actual = buildSrtSettings(
      policy({
        writablePaths: ["/repo/.git"],
        denyWritePaths: ["/repo/.git/hooks", "/repo/.git/config", "/repo/.git/hooks"],
      }),
      linuxOptions,
    );

    expect(actual.filesystem.allowWrite).toStrictEqual(["/repo/.git"]);
    // De-duplicated, and the whole .git stays writable alongside the denies.
    expect(actual.filesystem.denyWrite).toStrictEqual(["/repo/.git/hooks", "/repo/.git/config"]);
  });

  it("re-opens writablePaths and readOnlyPaths for read, plus the node runtime prefix", () => {
    const actual = buildSrtSettings(
      policy({ writablePaths: ["/work/ws"], readOnlyPaths: ["/repo/.git", "/opt/tools"] }),
      linuxOptions,
    );

    expect(actual.filesystem.allowRead).toContain("/work/ws");
    expect(actual.filesystem.allowRead).toContain("/repo/.git");
    expect(actual.filesystem.allowRead).toContain("/opt/tools");
    // <execPath>/../.. so a `#!/usr/bin/env node` command runs under the mask.
    expect(actual.filesystem.allowRead).toContain("/home/dev/.nvm/versions/node/v24");
  });

  it("masks the whole home region for reads (deny-by-default), per platform", () => {
    expect(buildSrtSettings(policy(), linuxOptions).filesystem.denyRead).toStrictEqual([
      "/home",
      "/root",
      "/mnt",
    ]);
    expect(
      buildSrtSettings(policy(), {
        platform: "darwin",
        nodeExecPath: "/Users/dev/.n/bin/node",
      }).filesystem.denyRead,
    ).toStrictEqual(["/Users"]);
  });

  it("dedupes read and write grants", () => {
    const actual = buildSrtSettings(
      policy({ writablePaths: ["/work/ws", "/work/ws"], readOnlyPaths: ["/work/ws"] }),
      linuxOptions,
    );

    expect(actual.filesystem.allowWrite).toStrictEqual(["/work/ws"]);
    expect(actual.filesystem.allowRead.filter((p) => p === "/work/ws")).toHaveLength(1);
  });

  it("builds an allow-only network policy from the entries, stripping ports and deduping", () => {
    const actual = buildSrtSettings(
      policy({ network: ["api.github.com", "api.linear.app:443", "api.github.com"] }),
      linuxOptions,
    );

    expect(actual.network.allowedDomains).toStrictEqual(["api.github.com", "api.linear.app"]);
    expect(actual.network.deniedDomains).toStrictEqual([]);
    expect(actual.network.allowLocalBinding).toBe(false);
    expect(actual.network.allowUnixSockets).toStrictEqual([]);
    expect(actual.network.allowAllUnixSockets).toBe(false);
  });

  it("treats an empty network list as deny-all egress (empty allowedDomains)", () => {
    expect(buildSrtSettings(policy({ network: [] }), linuxOptions).network.allowedDomains).toStrictEqual(
      [],
    );
  });

  it("enables pty for interactive agents and keeps git config writes locked", () => {
    const actual = buildSrtSettings(policy(), linuxOptions);

    expect(actual.allowPty).toBe(true);
    expect(actual.filesystem.allowGitConfig).toBe(false);
  });

  it("produces a config that satisfies srt's own runtime schema", () => {
    const actual = buildSrtSettings(
      policy({ writablePaths: ["/work/ws"], network: ["api.anthropic.com"] }),
      linuxOptions,
    );

    expect(() => SandboxRuntimeConfigSchema.parse(actual)).not.toThrow();
  });

  it("fails closed rather than emitting a network entry srt would reject and run unsandboxed", () => {
    // `*` is a deny-all wildcard srt refuses in allowedDomains; the port strip
    // leaves it intact, so schema validation must throw.
    expect(() => buildSrtSettings(policy({ network: ["*"] }), linuxOptions)).toThrow(
      /failed validation.*refusing to run unsandboxed/iu,
    );
  });

  it("defaults platform and node runtime to the current process when not injected", () => {
    const actual = buildSrtSettings(policy({ writablePaths: ["/work/ws"] }));

    expect(actual.filesystem.denyRead.length).toBeGreaterThan(0);
    expect(actual.filesystem.allowRead).toContain(nodeRuntimePrefix(process.execPath));
    expect(() => SandboxRuntimeConfigSchema.parse(actual)).not.toThrow();
  });
});

describe(homeReadMask, () => {
  it("masks /Users on macOS and the home roots + WSL mounts on Linux", () => {
    expect(homeReadMask("darwin")).toStrictEqual(["/Users"]);
    expect(homeReadMask("linux")).toStrictEqual(["/home", "/root", "/mnt"]);
  });
});

describe(nodeRuntimePrefix, () => {
  it("returns the runtime prefix two levels above the node binary", () => {
    expect(nodeRuntimePrefix("/opt/node/v24/bin/node")).toBe("/opt/node/v24");
  });
});

describe(toAllowedDomain, () => {
  it("keeps a bare host, strips a trailing :port, and drops a blank entry", () => {
    expect(toAllowedDomain("api.github.com")).toBe("api.github.com");
    expect(toAllowedDomain("api.linear.app:443")).toBe("api.linear.app");
    expect(toAllowedDomain("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(toAllowedDomain("  api.github.com  ")).toBe("api.github.com");
    expect(toAllowedDomain("   ")).toBeUndefined();
  });
});

describe(settingsHash, () => {
  it("is deterministic and content-sensitive", () => {
    const a = buildSrtSettings(policy({ writablePaths: ["/a"] }), linuxOptions);
    const b = buildSrtSettings(policy({ writablePaths: ["/b"] }), linuxOptions);

    expect(settingsHash(a)).toBe(settingsHash(a));
    expect(settingsHash(a)).not.toBe(settingsHash(b));
  });
});

describe(stageSettings, () => {
  let tmp: string;
  afterEach(() => {
    if (tmp !== undefined) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes the settings to a content-addressed path and round-trips the JSON", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sandbox-stage-"));
    const settings = buildSrtSettings(policy({ writablePaths: ["/work/ws"] }), linuxOptions);

    const file = stageSettings(settings, tmp);

    expect(file).toBe(
      path.join(tmp, "groundcrew-sandbox", `srt-${settingsHash(settings)}.json`),
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toStrictEqual(settings);
    // Idempotent: staging the same settings again returns the same path.
    expect(stageSettings(settings, tmp)).toBe(file);
  });
});

describe("loopback network entries", () => {
  it("maps loopback allowlist entries to allowLocalBinding, not allowedDomains", () => {
    const settings = buildSrtSettings({
      writablePaths: [],
      readOnlyPaths: [],
      network: ["127.0.0.1:8080", "localhost", "api.linear.app"],
    });

    expect(settings.network.allowLocalBinding).toBe(true);
    expect(settings.network.allowedDomains).toEqual(["api.linear.app"]);
  });

  it("keeps local binding off for remote-only allowlists", () => {
    const settings = buildSrtSettings({
      writablePaths: [],
      readOnlyPaths: [],
      network: ["api.linear.app"],
    });

    expect(settings.network.allowLocalBinding).toBe(false);
    expect(settings.network.allowedDomains).toEqual(["api.linear.app"]);
  });
});
