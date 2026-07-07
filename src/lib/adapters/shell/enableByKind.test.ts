import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AdapterContext } from "../../adapterDefinition.ts";
import { buildSourcesWith } from "../../buildSources.ts";
import type { ResolvedConfig } from "../../config.ts";
import { mergeManifestAdapters } from "../registry.ts";

import { discoverFromRoots } from "./discovery.ts";

const fakeContext: AdapterContext = { globalConfig: {} as ResolvedConfig };

describe("enable a manifest source by kind", () => {
  it("discovers, registers, and builds a source from { kind } alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "enable-by-kind-"));
    try {
      const bundleDir = path.join(root, "sources", "demo");
      const installDir = path.join(root, "install");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(path.join(bundleDir, "demo.sh"), "#!/bin/sh\n");
      writeFileSync(
        path.join(bundleDir, "source.json"),
        JSON.stringify({
          name: "demo",
          kind: "shell",
          description: "demo",
          installDir,
          files: ["demo.sh"],
          commands: { listTasks: `${installDir}/demo.sh list` },
        }),
      );

      const { manifests } = discoverFromRoots([
        { dir: path.join(root, "sources"), origin: "user" },
      ]);
      const registry = mergeManifestAdapters({}, manifests);
      const sources = buildSourcesWith(registry, [{ kind: "demo" }], fakeContext);

      expect(sources).toHaveLength(1);
      expect(sources[0]?.name).toBe("demo");
      expect(existsSync(path.join(installDir, "demo.sh"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
