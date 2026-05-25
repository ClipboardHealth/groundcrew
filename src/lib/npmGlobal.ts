import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const STDERR_CAPTURE_MAX_BYTES = 64 * 1024;

export type InstallKind = "global" | "linked" | "npx" | "project" | "unknown";

export interface ClassifyInstallOptions {
  installPath: string;
  npmRootGlobal: string | undefined;
  isSymlink: (path: string) => boolean;
}

export function classifyInstall(options: ClassifyInstallOptions): InstallKind {
  const { installPath, npmRootGlobal, isSymlink } = options;
  if (npmRootGlobal !== undefined && installPath.startsWith(`${npmRootGlobal}${sep}`)) {
    return isSymlink(installPath) ? "linked" : "global";
  }
  if (installPath.includes(`${sep}_npx${sep}`)) {
    return "npx";
  }
  if (installPath.includes(`${sep}node_modules${sep}`)) {
    return "project";
  }
  return "unknown";
}

export interface NpmSpawnerResult {
  exitCode: number;
  stderrText: string;
}

export type NpmSpawner = (command: string, args: readonly string[]) => Promise<NpmSpawnerResult>;

export interface NpmRunResult {
  exitCode: number;
  sawEacces: boolean;
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
    sawEacces: result.stderrText.includes("EACCES"),
  };
}

export function detectInstallPath(cliMetaUrl: string): string {
  return dirname(dirname(fileURLToPath(cliMetaUrl)));
}

export type NpmRootRunner = (command: string, args: readonly string[]) => string;

export function detectNpmRootGlobal(npmBin: string, runner: NpmRootRunner): string | undefined {
  try {
    return runner(npmBin, ["root", "-g"]);
  } catch {
    return undefined;
  }
}

export function detectIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function createDefaultNpmSpawner(passthroughStderr: NodeJS.WritableStream): NpmSpawner {
  return async (command, args) =>
    await new Promise<NpmSpawnerResult>((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["inherit", "inherit", "pipe"] });
      const { stderr } = child;
      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      let closeCode: number | null | undefined;
      let stderrEnded = false;
      let settled = false;

      function maybeResolve(): void {
        if (settled || closeCode === undefined || !stderrEnded) {
          return;
        }
        settled = true;
        resolve({
          exitCode: closeCode ?? 1,
          stderrText: Buffer.concat(chunks).toString("utf8"),
        });
      }

      stderr.on("data", (chunk: Buffer) => {
        const remainingBytes = STDERR_CAPTURE_MAX_BYTES - capturedBytes;
        if (remainingBytes > 0) {
          const captured = Buffer.from(chunk.subarray(0, remainingBytes));
          chunks.push(captured);
          capturedBytes += captured.length;
        }
        if (!passthroughStderr.write(chunk)) {
          stderr.pause();
          passthroughStderr.once("drain", () => {
            stderr.resume();
          });
        }
      });
      stderr.on("end", () => {
        stderrEnded = true;
        maybeResolve();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        closeCode = code;
        stderr.resume();
        maybeResolve();
      });
    });
}
