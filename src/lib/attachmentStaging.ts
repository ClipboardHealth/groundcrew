/**
 * Filename-safety and byte-cap primitives for staging task attachments into a
 * worktree. Consumed by the producing adapters (Linear download, shell
 * reconcile) as they land in follow-up slices. Dependency-free (Node builtins
 * only) so it stays extraction-ready.
 */

import path from "node:path";

/** Longest filename accepted verbatim; longer titles fall back to the stable form. */
const MAX_FILENAME_LENGTH = 255;

/** Characters of the source id kept in the `attachment-<id-prefix>` fallback name. */
const FALLBACK_ID_PREFIX_LENGTH = 8;

export interface SanitizeAttachmentFilenameArguments {
  /** Source-side display title, kept verbatim when it is a safe single path segment. */
  title: string;
  /** Stable source id used for the `attachment-<id-prefix>` fallback name. */
  fallbackId: string;
}

/**
 * Keep the source title verbatim when it is a safe single path segment
 * (spaces, capitalization, punctuation preserved); otherwise fall back to a
 * stable `attachment-<id-prefix>` name. Unsafe: empty, `.`/`..`, path
 * separators, NUL bytes, over-long.
 */
export function sanitizeAttachmentFilename(
  arguments_: SanitizeAttachmentFilenameArguments,
): string {
  const { title, fallbackId } = arguments_;
  if (isSafeFilename(title)) {
    return title;
  }
  return `attachment-${fallbackId.slice(0, FALLBACK_ID_PREFIX_LENGTH)}`;
}

export interface ResolveInsideStageDirArguments {
  /** Absolute path of the stage directory. */
  stageDir: string;
  /** Filename reported by a source; must be a single path segment. */
  filename: string;
}

/**
 * Resolve `filename` to its absolute path directly inside `stageDir`, or
 * `undefined` when the name escapes it (traversal, absolute path, nested
 * path, or a name resolving to the stage dir itself). The stage dir is flat:
 * subdirectories are never scanned, so nested paths are rejected outright.
 */
export function resolveInsideStageDir(
  arguments_: ResolveInsideStageDirArguments,
): string | undefined {
  const { stageDir, filename } = arguments_;
  const resolved = path.resolve(stageDir, filename);
  if (path.dirname(resolved) !== path.resolve(stageDir)) {
    return undefined;
  }
  return resolved;
}

type CapAdmission =
  | { admitted: true }
  | { admitted: false; reason: "exceeds-per-file-cap" | "exceeds-per-task-cap" };

export interface CreateCapAccountantArguments {
  maxAttachmentBytes: number;
  maxTotalBytes: number;
}

export interface CapAccountant {
  /** Admit or reject one file by size; admitted sizes accumulate toward the total cap. */
  admit: (sizeBytes: number) => CapAdmission;
}

/**
 * Central cap enforcement, one accountant per fetch: the per-file cap is
 * checked first (so an oversize file reports `exceeds-per-file-cap` even when
 * the total cap is also blown), and only admitted files count toward the
 * running total.
 */
export function createCapAccountant(arguments_: CreateCapAccountantArguments): CapAccountant {
  const { maxAttachmentBytes, maxTotalBytes } = arguments_;
  let totalBytes = 0;
  return {
    admit(sizeBytes: number): CapAdmission {
      if (sizeBytes > maxAttachmentBytes) {
        return { admitted: false, reason: "exceeds-per-file-cap" };
      }
      if (totalBytes + sizeBytes > maxTotalBytes) {
        return { admitted: false, reason: "exceeds-per-task-cap" };
      }
      totalBytes += sizeBytes;
      return { admitted: true };
    },
  };
}

function isSafeFilename(title: string): boolean {
  return (
    title.length > 0 &&
    title.length <= MAX_FILENAME_LENGTH &&
    title !== "." &&
    title !== ".." &&
    !title.includes("/") &&
    !title.includes("\\") &&
    !title.includes("\0")
  );
}
