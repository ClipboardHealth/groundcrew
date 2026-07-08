import { readFileSync } from "node:fs";
import path from "node:path";

import { sourceManifestSchema } from "./manifest.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");

const validManifest = {
  name: "jira",
  kind: "shell",
  description: "Feed JIRA issues into groundcrew.",
  installDir: "~/.config/groundcrew",
  files: ["jira.sh"],
  commands: { listTasks: "~/.config/groundcrew/jira.sh list" },
};

describe("sourceManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const parse = (): unknown => sourceManifestSchema.parse(validManifest);

    expect(parse).not.toThrow();
  });

  it("defaults files to an empty array when omitted", () => {
    const { files: _files, ...withoutFiles } = validManifest;
    const actual = sourceManifestSchema.parse(withoutFiles);

    expect(actual.files).toStrictEqual([]);
  });

  it("requires a listTasks command", () => {
    const input = { ...validManifest, commands: { verify: "jira me" } };
    const parse = (): unknown => sourceManifestSchema.parse(input);

    expect(parse).toThrow(/listTasks/i);
  });

  it("rejects a non-kebab-case name", () => {
    const input = { ...validManifest, name: "Jira_Source" };
    const parse = (): unknown => sourceManifestSchema.parse(input);

    expect(parse).toThrow(/kebab-case/i);
  });

  it("rejects unknown top-level fields", () => {
    const input = { ...validManifest, bogus: true };
    const parse = (): unknown => sourceManifestSchema.parse(input);

    expect(parse).toThrow(/unrecognized/i);
  });

  it("validates the shipped jira source manifest", () => {
    const raw = readFileSync(path.join(REPO_ROOT, "task-sources/jira/source.json"), "utf8");
    const input: unknown = JSON.parse(raw);
    const parse = (): unknown => sourceManifestSchema.parse(input);

    expect(parse).not.toThrow();
  });

  describe("prerequisite install", () => {
    const withInstall = (install: unknown): unknown => ({
      ...validManifest,
      prerequisites: [{ bin: "jira", install }],
    });

    it("accepts a plain-string install (applies to all platforms)", () => {
      const parse = (): unknown => sourceManifestSchema.parse(withInstall("brew install jira"));

      expect(parse).not.toThrow();
    });

    it("accepts a per-OS install object keyed by platform", () => {
      const parse = (): unknown =>
        sourceManifestSchema.parse(
          withInstall({
            darwin: "brew install jira",
            linux: "sudo apt-get install jira",
            default: "go install jira",
          }),
        );

      expect(parse).not.toThrow();
    });

    it("rejects an unknown key in a per-OS install object", () => {
      const parse = (): unknown =>
        sourceManifestSchema.parse(withInstall({ windows: "install manually" }));

      expect(parse).toThrow(/unrecognized/i);
    });
  });
});
