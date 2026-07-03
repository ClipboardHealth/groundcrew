import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

interface PackageJson {
  files: string[];
}

function readPackageJson(): PackageJson {
  const raw = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

describe("npm package contents", () => {
  it("ships the task-sources directory", () => {
    const { files } = readPackageJson();

    expect(files).toContain("task-sources");
  });

  it("has the packaged jira source manifest on disk", () => {
    const manifestPath = path.join(REPO_ROOT, "task-sources/jira/source.json");

    expect(() => readFileSync(manifestPath, "utf8")).not.toThrow();
  });
});
