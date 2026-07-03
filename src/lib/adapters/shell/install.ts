/**
 * Idempotent materialization of a task source's script files. Copies each
 * `files[]` entry from the manifest's directory into `installDir` when the destination is
 * missing or its bytes differ, then marks it executable. A manifest with no
 * `files` installs nothing (the source is backed by a binary already on PATH).
 * Never writes secrets - prerequisites and secrets stay the user's job.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expandHome } from "../../paths.ts";

import type { SourceManifest } from "./manifest.ts";

export interface InstallShellSourceOptions {
  manifest: SourceManifest;
  manifestDir: string;
}

export interface InstalledShellSource {
  installDir: string;
  scriptPaths: string[];
}

export function installShellSource(options: InstallShellSourceOptions): InstalledShellSource {
  const { manifest, manifestDir } = options;
  const installDir = expandHome(manifest.installDir);
  const scriptPaths: string[] = [];

  if (manifest.files.length > 0) {
    mkdirSync(installDir, { recursive: true });
  }

  for (const file of manifest.files) {
    const source = path.join(manifestDir, file);
    const dest = path.join(installDir, file);
    if (!existsSync(dest) || readFileSync(dest).compare(readFileSync(source)) !== 0) {
      copyFileSync(source, dest);
    }
    chmodSync(dest, 0o755);
    scriptPaths.push(dest);
  }

  return { installDir, scriptPaths };
}
