import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallKind = "global" | "linked" | "npx" | "project" | "unknown";

export interface ClassifyInstallOptions {
  installPath: string;
  npmRootGlobal: string | undefined;
  isSymlink: (path: string) => boolean;
}

export function classifyInstall(options: ClassifyInstallOptions): InstallKind {
  const { installPath, npmRootGlobal, isSymlink } = options;
  if (npmRootGlobal !== undefined && installPath.startsWith(`${npmRootGlobal}${path.sep}`)) {
    return isSymlink(installPath) ? "linked" : "global";
  }
  if (installPath.includes(`${path.sep}_npx${path.sep}`)) {
    return "npx";
  }
  if (installPath.includes(`${path.sep}node_modules${path.sep}`)) {
    return "project";
  }
  return "unknown";
}

export interface NpmSpawnerResult {
  exitCode: number;
  outputText: string;
}

export type NpmSpawner = (command: string, args: readonly string[]) => Promise<NpmSpawnerResult>;

export interface NpmRunResult {
  exitCode: number;
  sawEacces: boolean;
  outputText: string;
}

export interface RunNpmInstallOptions {
  packageName: string;
  version: string;
  npmBin: string;
  spawner: NpmSpawner;
}

export async function runNpmInstallGlobal(options: RunNpmInstallOptions): Promise<NpmRunResult> {
  const args = ["install", "-g", `${options.packageName}@${options.version}`];
  const result = await options.spawner(options.npmBin, args);
  return {
    exitCode: result.exitCode,
    sawEacces: result.outputText.includes("EACCES"),
    outputText: result.outputText,
  };
}

export function detectInstallPath(cliMetaUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(cliMetaUrl)));
}

export type NpmRootRunner = (command: string, args: readonly string[]) => string;

export function detectNpmRootGlobal(npmBin: string, runner: NpmRootRunner): string | undefined {
  try {
    return runner(npmBin, ["root", "-g"]);
  } catch {
    return undefined;
  }
}

export function detectIsSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function createDefaultNpmSpawner(): NpmSpawner {
  return async (command, args) =>
    await new Promise<NpmSpawnerResult>((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["inherit", "pipe", "pipe"] });
      const chunks: Buffer[] = [];

      const collect = (chunk: Buffer): void => {
        chunks.push(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          outputText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
}
