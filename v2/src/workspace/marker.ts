/**
 * The workspace marker `.groundcrew/task.json` (contracts §3.2) — the file
 * format the workspace module OWNS. Provisioning writes it; `crew repo add`
 * appends to `repos`; identity resolution reads `taskId` back out of it.
 */

import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { markerFilePath } from "./paths.js";

export const markerSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  branch: z.string(),
  repos: z.array(z.string()),
});

export type WorkspaceMarker = z.infer<typeof markerSchema>;

/** Reads and validates the marker in a workspace dir; `undefined` when absent. */
export function readMarker(input: {
  readonly workspaceDirectory: string;
}): WorkspaceMarker | undefined {
  const file = markerFilePath({ workspaceDirectory: input.workspaceDirectory });
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${file}: expected valid JSON.`, { cause: error });
  }

  return markerSchema.parse(parsed);
}

/** Writes the marker into a workspace dir, creating `.groundcrew/` as needed. */
export function writeMarker(input: {
  readonly workspaceDirectory: string;
  readonly marker: WorkspaceMarker;
}): void {
  const file = markerFilePath({ workspaceDirectory: input.workspaceDirectory });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(input.marker, undefined, 2) + "\n");
}

/**
 * Records `repo` in the marker's `repos` list (idempotent, sorted for a stable
 * on-disk shape). Creates the marker when absent — the runtime `repo add` path
 * can reach a workspace whose marker predates it.
 */
export function addRepoToMarker(input: {
  readonly workspaceDirectory: string;
  readonly taskId: string;
  readonly branch: string;
  readonly repo: string;
}): WorkspaceMarker {
  const existing = readMarker({ workspaceDirectory: input.workspaceDirectory });
  const repos = new Set([...(existing?.repos ?? []), input.repo]);

  const marker: WorkspaceMarker = {
    version: 1,
    taskId: existing?.taskId ?? input.taskId,
    branch: existing?.branch ?? input.branch,
    repos: [...repos].toSorted(),
  };
  writeMarker({ workspaceDirectory: input.workspaceDirectory, marker });
  return marker;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
