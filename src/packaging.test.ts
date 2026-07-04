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

  it("has the packaged jira source files on disk", () => {
    const manifestPath = path.join(REPO_ROOT, "task-sources/jira/source.json");
    const scriptPath = path.join(REPO_ROOT, "task-sources/jira/jira.sh");

    expect(() => readFileSync(manifestPath, "utf8")).not.toThrow();
    expect(() => readFileSync(scriptPath, "utf8")).not.toThrow();
  });
});
