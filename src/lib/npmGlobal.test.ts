import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyInstall,
  createDefaultNpmSpawner,
  detectInstallPath,
  detectIsSymlink,
  detectNpmRootGlobal,
  type NpmRootRunner,
  type NpmSpawner,
  runNpmInstallGlobal,
} from "./npmGlobal.ts";

const NOT_SYMLINK = () => false;
const IS_SYMLINK = () => true;

describe(classifyInstall, () => {
  it("returns 'global' when the install path is under npm root -g and is not a symlink", () => {
    const result = classifyInstall({
      installPath: `${sep}usr${sep}local${sep}lib${sep}node_modules${sep}@scope${sep}pkg`,
      npmRootGlobal: `${sep}usr${sep}local${sep}lib${sep}node_modules`,
      isSymlink: NOT_SYMLINK,
    });
    expect(result).toBe("global");
  });

  it("returns 'linked' when the install path is under npm root -g and is a symlink", () => {
    const result = classifyInstall({
      installPath: `${sep}usr${sep}local${sep}lib${sep}node_modules${sep}@scope${sep}pkg`,
      npmRootGlobal: `${sep}usr${sep}local${sep}lib${sep}node_modules`,
      isSymlink: IS_SYMLINK,
    });
    expect(result).toBe("linked");
  });

  it("returns 'npx' when the install path is under the npm _npx cache", () => {
    const result = classifyInstall({
      installPath: `${sep}home${sep}u${sep}.npm${sep}_npx${sep}abc${sep}node_modules${sep}@scope${sep}pkg`,
      npmRootGlobal: `${sep}usr${sep}local${sep}lib${sep}node_modules`,
      isSymlink: NOT_SYMLINK,
    });
    expect(result).toBe("npx");
  });

  it("returns 'project' for an arbitrary node_modules outside npm root -g", () => {
    const result = classifyInstall({
      installPath: `${sep}home${sep}u${sep}proj${sep}node_modules${sep}@scope${sep}pkg`,
      npmRootGlobal: `${sep}usr${sep}local${sep}lib${sep}node_modules`,
      isSymlink: NOT_SYMLINK,
    });
    expect(result).toBe("project");
  });

  it("returns 'unknown' when no path heuristic matches", () => {
    const result = classifyInstall({
      installPath: `${sep}opt${sep}weird${sep}place${sep}pkg`,
      npmRootGlobal: `${sep}usr${sep}local${sep}lib${sep}node_modules`,
      isSymlink: NOT_SYMLINK,
    });
    expect(result).toBe("unknown");
  });

  it("treats npmRootGlobal=undefined as 'no global match' and falls through", () => {
    const result = classifyInstall({
      installPath: `${sep}home${sep}u${sep}proj${sep}node_modules${sep}@scope${sep}pkg`,
      npmRootGlobal: undefined,
      isSymlink: NOT_SYMLINK,
    });
    expect(result).toBe("project");
  });
});

describe(runNpmInstallGlobal, () => {
  it("invokes npm install -g <package>@<version> and forwards the exit code", async () => {
    const spawner = vi.fn<NpmSpawner>().mockResolvedValueOnce({ exitCode: 0, outputText: "" });
    const result = await runNpmInstallGlobal({
      packageName: "@scope/pkg",
      version: "3.2.0",
      npmBin: "/usr/local/bin/npm",
      spawner,
    });
    expect(spawner).toHaveBeenCalledWith("/usr/local/bin/npm", [
      "install",
      "-g",
      "@scope/pkg@3.2.0",
    ]);
    expect(result).toStrictEqual({ exitCode: 0, sawEacces: false, outputText: "" });
  });

  it("forwards a non-zero exit code", async () => {
    const spawner = vi.fn<NpmSpawner>().mockResolvedValueOnce({ exitCode: 1, outputText: "boom" });
    const result = await runNpmInstallGlobal({
      packageName: "@scope/pkg",
      version: "3.2.0",
      npmBin: "npm",
      spawner,
    });
    expect(result).toStrictEqual({ exitCode: 1, sawEacces: false, outputText: "boom" });
  });

  it("flags sawEacces when captured output contains EACCES", async () => {
    const spawner = vi
      .fn<NpmSpawner>()
      .mockResolvedValueOnce({ exitCode: 243, outputText: "npm ERR! EACCES: permission denied" });
    const result = await runNpmInstallGlobal({
      packageName: "@scope/pkg",
      version: "3.2.0",
      npmBin: "npm",
      spawner,
    });
    expect(result).toStrictEqual({
      exitCode: 243,
      sawEacces: true,
      outputText: "npm ERR! EACCES: permission denied",
    });
  });
});

describe(createDefaultNpmSpawner, () => {
  it("captures both stdout and stderr from a real subprocess", async () => {
    const spawner = createDefaultNpmSpawner();
    const result = await spawner(process.execPath, [
      "--eval",
      String.raw`process.stdout.write('changed 24 packages\n'); process.stderr.write('EACCES: permission denied\n'); process.exit(2);`,
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.outputText).toContain("EACCES");
    expect(result.outputText).toContain("changed 24 packages");
  });

  it("rejects when the subprocess cannot be spawned", async () => {
    const spawner = createDefaultNpmSpawner();
    await expect(spawner("/definitely/missing/npm", [])).rejects.toThrow(/ENOENT/);
  });

  it("reports exit code 0 for a successful subprocess", async () => {
    const spawner = createDefaultNpmSpawner();
    const result = await spawner(process.execPath, ["--eval", "process.exit(0)"]);
    expect(result.exitCode).toBe(0);
    expect(result.outputText).toBe("");
  });

  it("reports exit code 1 when the subprocess is terminated by a signal", async () => {
    const spawner = createDefaultNpmSpawner();
    const result = await spawner(process.execPath, [
      "--eval",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    expect(result.exitCode).toBe(1);
  });
});

describe(detectInstallPath, () => {
  it("returns the parent of the directory containing the CLI file", () => {
    const fakeUrl = pathToFileURL("/opt/pkg/dist/cli.js").toString();
    expect(detectInstallPath(fakeUrl)).toBe(`${sep}opt${sep}pkg`);
  });
});

describe(detectNpmRootGlobal, () => {
  it("returns the runner output on success", () => {
    const runner = vi.fn<NpmRootRunner>().mockReturnValue("/usr/local/lib/node_modules");
    expect(detectNpmRootGlobal("npm", runner)).toBe("/usr/local/lib/node_modules");
    expect(runner).toHaveBeenCalledWith("npm", ["root", "-g"]);
  });

  it("returns undefined when the runner throws", () => {
    const runner = vi.fn<NpmRootRunner>().mockImplementation(() => {
      throw new Error("npm not found");
    });
    expect(detectNpmRootGlobal("npm", runner)).toBeUndefined();
  });
});

describe(detectIsSymlink, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "groundcrew-symlink-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for a symlink", () => {
    const target = join(tmp, "target");
    writeFileSync(target, "");
    const link = join(tmp, "link");
    symlinkSync(target, link);
    expect(detectIsSymlink(link)).toBe(true);
  });

  it("returns false for a regular file", () => {
    const file = join(tmp, "file");
    writeFileSync(file, "");
    expect(detectIsSymlink(file)).toBe(false);
  });

  it("returns false when the path does not exist", () => {
    expect(detectIsSymlink(join(tmp, "missing"))).toBe(false);
  });
});
