/**
 * `crew setup repos <new-repo>` — add a single repository to the user's
 * `workspace.knownRepositories` array and initialize it by cloning into
 * `workspace.projectDir`. Idempotent: re-running with an already-known and
 * already-cloned repo reports no work. Bare-name entries are added to the
 * config but not cloned, because the canonical remote URL is unknowable
 * without involving the user's `gh` login.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { runCommandAsync } from "../lib/commandRunner.ts";
import { findConfigFilepath, loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import { errorMessage, log, parseDryRunPositionals, writeOutput } from "../lib/util.ts";

export interface SetupReposOptions {
  /** Repository identifier. Either `<owner>/<repo>` or bare `<name>`. */
  repository: string;
  /** Print the plan without touching the config file or running clone. */
  dryRun?: boolean;
}

export type SetupReposConfigChange = "added" | "already-present" | "would-add";

export type SetupReposCloneChange =
  | "cloned"
  | "would-clone"
  | "already-cloned"
  | "skipped-bare-name"
  | "skipped-target-not-directory"
  | "gh-missing"
  | "failed";

export interface SetupReposResult {
  repository: string;
  /** Absolute path the repo should live at under `projectDir`. */
  target: string;
  configChange: SetupReposConfigChange;
  cloneChange: SetupReposCloneChange;
  /** Set only when `cloneChange === "failed"`. */
  cloneError?: Error;
}

const KNOWN_REPOSITORIES_RE =
  /(?:["']knownRepositories["']|knownRepositories)\s*:\s*\[([\s\S]*?)\]/d;
const QUOTED_STRING_RE = /(['"])([\s\S]*?)\1/dg;
const ENTRY_INDENT_RE = /^([ \t]+)["']/;

interface ParsedEntry {
  value: string;
}

/**
 * Replaces string contents and comment contents in `text` with placeholder
 * characters of the same length, preserving structural characters (brackets,
 * commas, the boundary quote/comment markers themselves). This lets a
 * structure-only regex on the masked text find the real `knownRepositories`
 * array without being misled by:
 *
 * - JSDoc or `//` comments that mention `knownRepositories: [...]` as an
 *   example (otherwise the regex picks the first textual match, not the
 *   real declaration);
 * - string entries that contain a literal `]` (otherwise the non-greedy
 *   body match terminates inside the string).
 *
 * The masked text has identical length and identical newline placement, so
 * positions returned by the regex map 1:1 back to the original text.
 */
type ScanState = "code" | "line-comment" | "block-comment" | "str-sq" | "str-dq" | "str-bt";

const STRING_CLOSE_CHARS: Record<"str-sq" | "str-dq" | "str-bt", string> = {
  "str-sq": "'",
  "str-dq": '"',
  "str-bt": "`",
};

function maskNonCode(text: string): string {
  // Spread iterates by code point, which would re-encode surrogate pairs;
  // for our purpose we only inspect ASCII syntax characters and `.join("")`
  // re-emits the original code units, so any non-ASCII content round-trips
  // unchanged through the array.
  // oxlint-disable-next-line typescript/no-misused-spread -- structural-only scan; we don't care about non-ASCII grapheme integrity
  const chars = [...text];
  let state: ScanState = "code";
  let index = 0;
  while (index < chars.length) {
    const ch = chars[index];
    const next = chars[index + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "line-comment";
        index += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "block-comment";
        index += 2;
        continue;
      }
      if (ch === "'") {
        state = "str-sq";
      } else if (ch === '"') {
        state = "str-dq";
      } else if (ch === "`") {
        state = "str-bt";
      }
      index += 1;
      continue;
    }
    if (state === "line-comment") {
      if (ch === "\n") {
        state = "code";
      } else {
        chars[index] = " ";
      }
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "code";
        index += 2;
        continue;
      }
      if (ch !== "\n") {
        chars[index] = " ";
      }
      index += 1;
      continue;
    }
    // String states: str-sq | str-dq | str-bt
    if (ch === "\\") {
      chars[index] = "_";
      /* v8 ignore next 3 @preserve -- guards against `\` as the final code unit of the input, which a well-formed config file cannot produce */
      if (index + 1 < chars.length) {
        chars[index + 1] = "_";
      }
      index += 2;
      continue;
    }
    const closeChar = STRING_CLOSE_CHARS[state];
    if (ch === closeChar) {
      state = "code";
    } else {
      chars[index] = "_";
    }
    index += 1;
  }
  return chars.join("");
}

function detectEntryIndent(body: string): string {
  const lines = body.split("\n");
  let indent = "  ";
  for (const line of lines) {
    const indentMatch = ENTRY_INDENT_RE.exec(line);
    const captured = indentMatch?.[1];
    if (captured !== undefined) {
      indent = captured;
    }
  }
  return indent;
}

function buildSingleLineBody(existing: ParsedEntry[], repository: string): string {
  const allValues = [...existing.map((entry) => entry.value), repository];
  return allValues.map((value) => `"${value}"`).join(", ");
}

function buildMultiLineBody(body: string, bodyMasked: string, repository: string): string {
  const indent = detectEntryIndent(body);
  // Match the existing line ending so a CRLF-formatted file stays CRLF, and
  // split on the WHOLE terminator so the insertion lands between the last
  // entry line and the closing bracket without orphaning a `\r`.
  const lineEnding = body.includes("\r\n") ? "\r\n" : "\n";
  const lastLineEndingIndex = body.lastIndexOf(lineEnding);
  const beforeClosing = body.slice(0, lastLineEndingIndex);
  const afterLastNewline = body.slice(lastLineEndingIndex);
  // Decide whether the last code-level character before the closing bracket
  // already terminates an entry with `,`. Inspect the masked text (comments
  // and string interiors blanked out) so a trailing `,` inside a comment
  // doesn't fool the check, and the new entry isn't appended after a
  // commented-out line as if it were inside the comment.
  const trimmedBeforeMasked = bodyMasked.slice(0, lastLineEndingIndex).trim();
  const needsLeadingComma = trimmedBeforeMasked.length > 0 && !trimmedBeforeMasked.endsWith(",");
  const leadingComma = needsLeadingComma ? "," : "";
  return `${beforeClosing}${leadingComma}${lineEnding}${indent}"${repository}",${afterLastNewline}`;
}

/**
 * Scans `bodyMasked` for quoted-string boundaries (every `'`/`"` in the
 * masked text is necessarily a real string delimiter, never a character
 * inside another string or comment) and returns the corresponding raw
 * entries from `bodyOriginal` by slicing at the matched positions.
 */
function parseExistingEntries(bodyMasked: string, bodyOriginal: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const match of bodyMasked.matchAll(QUOTED_STRING_RE)) {
    const indices = match.indices?.[2];
    /* v8 ignore next 3 @preserve -- QUOTED_STRING_RE has the `/d` flag and always exposes capture-group 2 indices on a successful match */
    if (indices === undefined) {
      continue;
    }
    entries.push({ value: bodyOriginal.slice(indices[0], indices[1]) });
  }
  return entries;
}

/**
 * Inserts `repository` into the `workspace.knownRepositories: [...]` array
 * literal of a TypeScript or JavaScript config file. Returns the new text and
 * whether the entry was already present (in which case `text` is unchanged).
 * Preserves single-line vs multi-line shape and existing indentation; new
 * entries are emitted with double quotes (matching the shipped example).
 *
 * Locates the array via a comment-/string-aware mask of the original text so
 * a JSDoc example like `// knownRepositories: ["foo/bar"]` cannot trick the
 * editor into corrupting a comment, and so a literal `]` inside an existing
 * entry cannot truncate the matched body.
 *
 * Throws when:
 * - the `knownRepositories` key cannot be located in code (only-in-comment
 *   occurrences do not count);
 * - any entry is written as a template literal (backticks), which the
 *   double-quoted entry writer cannot safely round-trip.
 */
export function addRepositoryToConfigText(
  text: string,
  repository: string,
): { text: string; alreadyPresent: boolean } {
  const masked = maskNonCode(text);
  const match = KNOWN_REPOSITORIES_RE.exec(masked);
  if (match === null) {
    throw new Error(
      `Could not locate \`workspace.knownRepositories\` array in config file. Add "${repository}" to the array by hand.`,
    );
  }
  const bodyIndices = match.indices?.[1];
  /* v8 ignore next 5 @preserve -- KNOWN_REPOSITORIES_RE has the `/d` flag and always exposes capture-group 1 indices on a successful match */
  if (bodyIndices === undefined) {
    throw new Error(
      `Could not parse workspace.knownRepositories array (match succeeded but capture indices were missing).`,
    );
  }
  const [bodyStart, bodyEnd] = bodyIndices;
  const body = text.slice(bodyStart, bodyEnd);
  const bodyMasked = masked.slice(bodyStart, bodyEnd);
  if (bodyMasked.includes("`")) {
    throw new Error(
      `\`workspace.knownRepositories\` contains a template-literal entry, which the editor cannot safely rewrite. Add "${repository}" to the array by hand.`,
    );
  }
  const entries = parseExistingEntries(bodyMasked, body);
  if (entries.some((entry) => entry.value === repository)) {
    return { text, alreadyPresent: true };
  }
  const newBody = body.includes("\n")
    ? buildMultiLineBody(body, bodyMasked, repository)
    : buildSingleLineBody(entries, repository);
  return {
    text: `${text.slice(0, bodyStart)}${newBody}${text.slice(bodyEnd)}`,
    alreadyPresent: false,
  };
}

function validateRepositoryFormat(repository: string): void {
  if (repository.length === 0) {
    throw new Error("crew setup repos: <new-repo> must be a non-empty repository identifier");
  }
  const parts = repository.split("/");
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid repository "${repository}": use either "owner/repo" or "repo".`);
  }
}

function isInsideProjectDir(projectDir: string, target: string): boolean {
  const rel = relative(projectDir, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

type TargetState = "missing" | "directory" | "not-directory";

function targetState(target: string): TargetState {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (stats === undefined) {
    return "missing";
  }
  if (!stats.isDirectory()) {
    return "not-directory";
  }
  return "directory";
}

function applyConfigChange(args: {
  configFilepath: string;
  repository: string;
  dryRun: boolean;
}): SetupReposConfigChange {
  const existingText = readFileSync(args.configFilepath, "utf8");
  const { text: newText, alreadyPresent } = addRepositoryToConfigText(
    existingText,
    args.repository,
  );
  if (alreadyPresent) {
    log(`[exists] ${args.repository} already in workspace.knownRepositories`);
    return "already-present";
  }
  if (args.dryRun) {
    log(
      `[dry-run] would add ${args.repository} to workspace.knownRepositories in ${args.configFilepath}`,
    );
    return "would-add";
  }
  writeFileSync(args.configFilepath, newText);
  log(`[added] ${args.repository} → workspace.knownRepositories in ${args.configFilepath}`);
  return "added";
}

async function cloneRepository(args: {
  repository: string;
  target: string;
}): Promise<{ change: SetupReposCloneChange; error?: Error }> {
  const ghPath = await which("gh");
  if (ghPath === undefined) {
    writeOutput(
      "gh CLI not found - install GitHub CLI from https://cli.github.com/ (or clone the repo manually).",
    );
    return { change: "gh-missing" };
  }
  log(`[clone] ${args.repository} → ${args.target}`);
  try {
    mkdirSync(dirname(args.target), { recursive: true });
    await runCommandAsync("gh", ["repo", "clone", args.repository, args.target], {
      stdio: "inherit",
      timeoutMs: 0,
    });
    return { change: "cloned" };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(errorMessage(error));
    log(`[fail] ${args.repository}: ${wrapped.message}`);
    return { change: "failed", error: wrapped };
  }
}

export async function setupRepos(
  config: ResolvedConfig,
  configFilepath: string,
  options: SetupReposOptions,
): Promise<SetupReposResult> {
  const { repository, dryRun = false } = options;
  validateRepositoryFormat(repository);
  const projectDir = resolve(config.workspace.projectDir);
  const target = resolve(projectDir, repository);
  if (!isInsideProjectDir(projectDir, target)) {
    throw new Error(
      `Repository "${repository}" resolves outside workspace.projectDir (${projectDir}): ${target}`,
    );
  }

  const configChange = applyConfigChange({ configFilepath, repository, dryRun });

  const state = targetState(target);
  if (state === "not-directory") {
    log(`[skip] ${repository} — target exists but is not a directory: ${target}`);
    return { repository, target, configChange, cloneChange: "skipped-target-not-directory" };
  }
  if (state === "directory") {
    log(`[exists] ${target}`);
    return { repository, target, configChange, cloneChange: "already-cloned" };
  }

  const isBareName = !repository.includes("/");
  if (isBareName) {
    log(
      `[skip] ${repository} — bare name needs owner/ prefix to auto-clone; clone manually into ${target}`,
    );
    return { repository, target, configChange, cloneChange: "skipped-bare-name" };
  }

  if (dryRun) {
    log(`[dry-run] would clone ${repository} → ${target}`);
    return { repository, target, configChange, cloneChange: "would-clone" };
  }

  const cloneResult = await cloneRepository({ repository, target });
  const result: SetupReposResult = {
    repository,
    target,
    configChange,
    cloneChange: cloneResult.change,
  };
  if (cloneResult.error !== undefined) {
    result.cloneError = cloneResult.error;
  }
  return result;
}

function parseArguments(argv: string[]): SetupReposOptions {
  const { dryRun, positionals } = parseDryRunPositionals(
    argv,
    "crew setup repos [--dry-run] <new-repo>",
  );
  const [repository] = positionals;
  if (positionals.length !== 1 || repository === undefined) {
    throw new Error("Usage: crew setup repos [--dry-run] <new-repo>");
  }
  return { repository, dryRun };
}

const EXIT_CODE_CLONE_CHANGES: ReadonlySet<SetupReposCloneChange> = new Set([
  "failed",
  "gh-missing",
  "skipped-bare-name",
  "skipped-target-not-directory",
]);

export async function setupReposCli(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  const [config, configFilepath] = await Promise.all([loadConfig(), findConfigFilepath()]);
  const result = await setupRepos(config, configFilepath, options);
  if (EXIT_CODE_CLONE_CHANGES.has(result.cloneChange)) {
    process.exitCode = 1;
  }
}
