import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig } from "../../config.ts";

import { manifestAdapter, manifestMeta, shellConfigFromManifest } from "./manifestAdapter.ts";
import type { SourceManifest } from "./manifest.ts";

const fakeContext: AdapterContext = { globalConfig: {} as ResolvedConfig };

function manifestWith(overrides: Partial<SourceManifest>): SourceManifest {
  return {
    name: "demo",
    kind: "shell",
    description: "demo",
    installDir: "/replaced/in/test",
    files: [],
    env: { A: "1" },
    commands: { listTasks: "demo list" },
    ...overrides,
  };
}

describe("shellConfigFromManifest", () => {
  it("passes commands through and defaults the name to the manifest name", () => {
    const actual = shellConfigFromManifest(manifestWith({}));

    expect(actual.kind).toBe("shell");
    expect(actual.name).toBe("demo");
    expect(actual.commands.listTasks).toBe("demo list");
  });

  it("shallow-merges env overrides over the manifest defaults", () => {
    const actual = shellConfigFromManifest(manifestWith({ env: { A: "1", B: "2" } }), {
      env: { B: "override" },
    });

    expect(actual.env).toStrictEqual({ A: "1", B: "override" });
  });

  it("prefers an override name and timeouts over the manifest values", () => {
    const actual = shellConfigFromManifest(manifestWith({ name: "demo" }), {
      name: "renamed",
      timeouts: { listTasks: 1234 },
    });

    expect(actual.name).toBe("renamed");
    expect(actual.timeouts).toStrictEqual({ listTasks: 1234 });
  });
});

describe("manifestMeta", () => {
  it("marks a source with secrets as requiring credentials", () => {
    const actual = manifestMeta(
      manifestWith({
        description: "JIRA source",
        secrets: [{ env: "JIRA_API_TOKEN", file: "jira.token" }],
      }),
      "package",
    );

    expect(actual).toStrictEqual({
      description: "JIRA source",
      requiresCredentials: true,
      origin: "package",
    });
  });

  it("marks a secret-free source as not requiring credentials and carries the origin", () => {
    const actual = manifestMeta(manifestWith({ description: "no secrets" }), "user");

    expect(actual).toStrictEqual({
      description: "no secrets",
      requiresCredentials: false,
      origin: "user",
    });
  });
});

describe("manifestAdapter", () => {
  it("exposes the manifest name as the adapter kind", () => {
    const adapter = manifestAdapter(manifestWith({ name: "jira" }), "/tmp/x", "package");

    expect(adapter.kind).toBe("jira");
    expect(() => adapter.configSchema.parse({ kind: "jira" })).not.toThrow();
    expect(() => adapter.configSchema.parse({ kind: "jira", bogus: true })).toThrow(
      /unrecognized/i,
    );
  });

  it("derives catalog meta from the manifest and the discovery origin", () => {
    const adapter = manifestAdapter(
      manifestWith({
        name: "jira",
        description: "JIRA source",
        secrets: [{ env: "JIRA_API_TOKEN", file: "jira.token" }],
      }),
      "/tmp/x",
      "package",
    );

    expect(adapter.meta).toStrictEqual({
      description: "JIRA source",
      requiresCredentials: true,
      origin: "package",
    });
  });

  it("installs scripts then builds a shell task source on create", () => {
    const root = mkdtempSync(path.join(tmpdir(), "manifest-adapter-"));
    try {
      const manifestDir = path.join(root, "manifest");
      const installDir = path.join(root, "install");
      mkdirSync(manifestDir);
      writeFileSync(path.join(manifestDir, "demo.sh"), "#!/bin/sh\n");
      const manifest = manifestWith({ installDir, files: ["demo.sh"] });
      const adapter = manifestAdapter(manifest, manifestDir, "user");

      const source = adapter.create({ kind: "demo" }, fakeContext);

      expect(source.name).toBe("demo");
      expect(existsSync(path.join(installDir, "demo.sh"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
