/**
 * Textual rewriter for the workspace.knownRepositories array literal in
 * the user's resolved config.ts. We scan rather than parse so we keep
 * zero new dependencies; anything we cannot reason about (multiple
 * occurrences, non-string entries, missing literal) aborts cleanly so the
 * user can edit the file by hand.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const KEY = "knownRepositories";

interface UpdateKnownRepositoriesInput {
  configPath: string;
  toAdd: readonly string[];
}

interface UpdateKnownRepositoriesResult {
  added: string[];
  alreadyPresent: string[];
}

interface ArrayLiteral {
  open: number;
  close: number;
}

interface Entry {
  value: string;
  start: number;
  end: number;
}

interface KeyMatch {
  literal: ArrayLiteral | undefined;
  next: number;
}

const LEADING_WHITESPACE = /^[\t ]*/;
const ONLY_WHITESPACE = /^[\t ]*$/;
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;
const ANY_NON_WHITESPACE = /\S/;
const TEMPLATE_INTERPOLATION_TOKEN = String.fromCodePoint(36, 123);
const BACKSLASH_APOSTROPHE = String.fromCodePoint(92, 39);
const BACKSLASH_DOUBLE_QUOTE = String.fromCodePoint(92, 34);
const DOUBLE_QUOTE = String.fromCodePoint(34);

export function updateKnownRepositoriesInConfigFile(
  input: UpdateKnownRepositoriesInput,
): UpdateKnownRepositoriesResult {
  const source = readFileSync(input.configPath, "utf8");
  const literal = findKnownRepositoriesArray(source);
  const entries = parseEntries(source, literal);

  const present = new Set(entries.map((entry) => entry.value));
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const value of input.toAdd) {
    if (present.has(value)) {
      alreadyPresent.push(value);
      continue;
    }
    added.push(value);
    present.add(value);
  }

  if (added.length === 0) {
    return { added, alreadyPresent };
  }

  const next = rewrite({ source, literal, entries, added });
  writeAtomically(input.configPath, next);

  return { added, alreadyPresent };
}

function findKnownRepositoriesArray(source: string): ArrayLiteral {
  const candidates: ArrayLiteral[] = [];
  let index = 0;
  while (index < source.length) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const matched = tryMatchKeyAt(source, index);
    if (matched.literal !== undefined) {
      candidates.push(matched.literal);
    }
    index = matched.next;
  }
  return assertSoleCandidate(candidates);
}

function assertSoleCandidate(candidates: readonly ArrayLiteral[]): ArrayLiteral {
  if (candidates.length === 0) {
    throw new Error(
      "groundcrew config: couldn't find a `knownRepositories: [...]` array literal — please add entries manually",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "groundcrew config: multiple `knownRepositories` array literals found — please resolve manually",
    );
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- length === 1 guarantees the entry exists.
  return candidates[0]!;
}

/** Returns end index after any comment/string starting at the given index, or the index itself when none. */
function skipNonCode(source: string, index: number): number {
  const ch = source.charAt(index);
  if (ch === '"' || ch === "'" || ch === "`") {
    return skipString(source, index);
  }
  return skipComment(source, index);
}

function tryMatchKeyAt(source: string, index: number): KeyMatch {
  const ch = source.charAt(index);
  const prev = source.charAt(index - 1);
  if (!IDENTIFIER_START.test(ch) || IDENTIFIER_PART.test(prev)) {
    return { literal: undefined, next: index + 1 };
  }
  let end = index + 1;
  while (end < source.length && IDENTIFIER_PART.test(source.charAt(end))) {
    end += 1;
  }
  const ident = source.slice(index, end);
  if (ident !== KEY || prev === ".") {
    return { literal: undefined, next: end };
  }
  const literal = tryReadArrayAssignment(source, end);
  if (literal === undefined) {
    return { literal: undefined, next: end };
  }
  return { literal, next: literal.close + 1 };
}

function tryReadArrayAssignment(source: string, after: number): ArrayLiteral | undefined {
  let index = skipWhitespace(source, after);
  if (source.charAt(index) !== ":") {
    return undefined;
  }
  index = skipWhitespace(source, index + 1);
  if (source.charAt(index) !== "[") {
    return undefined;
  }
  return scanArrayClose(source, index);
}

function scanArrayClose(source: string, open: number): ArrayLiteral {
  let depth = 1;
  let index = open + 1;
  while (index < source.length) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      /* v8 ignore next 3 @preserve -- skipNonCode returning source.length means a line comment ran to EOF inside the literal; defensive guard, configs always close the array before EOF. */
      if (skipped === source.length) {
        throw new Error("groundcrew config: unterminated knownRepositories array literal");
      }
      index = skipped;
      continue;
    }
    const ch = source.charAt(index);
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return { open, close: index };
      }
    }
    index += 1;
  }
  /* v8 ignore next 2 @preserve -- reached only when the array literal extends past EOF; configs always close the array. */
  throw new Error("groundcrew config: unterminated knownRepositories array literal");
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && WHITESPACE.test(source.charAt(index))) {
    index += 1;
  }
  return index;
}

function skipString(source: string, start: number): number {
  const quote = source.charAt(start);
  let index = start + 1;
  while (index < source.length) {
    const ch = source.charAt(index);
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === quote) {
      return index + 1;
    }
    /* v8 ignore next 3 @preserve -- TS source files never embed raw newlines in single/double-quoted strings; defensive guard. */
    if (ch === "\n" && quote !== "`") {
      throw new Error("groundcrew config: unterminated string literal in config");
    }
    index += 1;
  }
  /* v8 ignore next 2 @preserve -- string extending past EOF means a malformed source file. */
  throw new Error("groundcrew config: unterminated string literal in config");
}

function parseEntries(source: string, literal: ArrayLiteral): Entry[] {
  const entries: Entry[] = [];
  let index = literal.open + 1;
  while (index < literal.close) {
    const ch = source.charAt(index);
    if (WHITESPACE.test(ch) || ch === ",") {
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = index;
      const end = skipString(source, index);
      const raw = source.slice(start, end);
      entries.push({ value: unquote(raw), start, end });
      index = end;
      continue;
    }
    const skipped = skipComment(source, index);
    if (skipped !== index) {
      index = Math.min(skipped, literal.close);
      continue;
    }
    throw new TypeError(
      `groundcrew config: unexpected token ${ch} in knownRepositories — only string literals are supported`,
    );
  }
  return entries;
}

function skipComment(source: string, index: number): number {
  const ch = source.charAt(index);
  const next = source.charAt(index + 1);
  if (ch === "/" && next === "/") {
    const nl = source.indexOf("\n", index);
    return nl === -1 ? source.length : nl + 1;
  }
  if (ch === "/" && next === "*") {
    const end = source.indexOf("*/", index + 2);
    /* v8 ignore next 3 @preserve -- malformed source with an unterminated block comment is a malformed .ts file; the user fixes it before retrying. */
    if (end === -1) {
      throw new Error("groundcrew config: unterminated block comment");
    }
    return end + 2;
  }
  return index;
}

function unquote(raw: string): string {
  const head = raw.charAt(0);
  if (head === '"') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- raw is a verbatim "…" JSON string literal from the source.
    return JSON.parse(raw) as string;
  }
  if (head === "'") {
    const body = raw
      .slice(1, -1)
      .replaceAll(BACKSLASH_APOSTROPHE, "'")
      .replaceAll(DOUBLE_QUOTE, BACKSLASH_DOUBLE_QUOTE);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- body comes from a single-quoted source string; the wrap-and-parse fixes escapes.
    return JSON.parse(DOUBLE_QUOTE + body + DOUBLE_QUOTE) as string;
  }
  if (raw.includes(TEMPLATE_INTERPOLATION_TOKEN)) {
    throw new TypeError(
      "groundcrew config: template literals with interpolation are not supported in knownRepositories",
    );
  }
  return raw.slice(1, -1);
}

interface RewriteInput {
  source: string;
  literal: ArrayLiteral;
  entries: Entry[];
  added: readonly string[];
}

function rewrite(input: RewriteInput): string {
  const { source, literal, entries, added } = input;
  const lineEnd = source.includes("\r\n") ? "\r\n" : "\n";
  const body = source.slice(literal.open + 1, literal.close);
  const isMultiLine = body.includes("\n");

  if (entries.length === 0) {
    return rewriteEmpty({ source, literal, added, lineEnd, isMultiLine });
  }

  // oxlint-disable typescript/no-non-null-assertion -- entries.length > 0 guarantees both elements exist.
  const firstEntry = entries[0]!;
  const lastEntry = entries.at(-1)!;
  // oxlint-enable typescript/no-non-null-assertion

  if (!isMultiLine) {
    return rewriteInline({ source, literal, added, lastEntry });
  }

  return rewriteMultiLine({ source, literal, added, firstEntry, lastEntry, lineEnd });
}

interface RewriteEmptyInput {
  source: string;
  literal: ArrayLiteral;
  added: readonly string[];
  lineEnd: string;
  isMultiLine: boolean;
}

function rewriteEmpty(input: RewriteEmptyInput): string {
  const { source, literal, added, lineEnd, isMultiLine } = input;
  const outerIndent = detectOuterIndent(source, literal);
  const head = source.slice(0, literal.open + 1);
  const tail = source.slice(literal.close);
  if (added.length === 1 && !isMultiLine) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- length === 1 guarantees the entry.
    return [head, wrapInQuotes(added[0]!), tail].join("");
  }
  const entryIndent = [outerIndent, "  "].join("");
  const lines = added
    .map((value) => [entryIndent, wrapInQuotes(value), ","].join(""))
    .join(lineEnd);
  return [head, lineEnd, lines, lineEnd, outerIndent, tail].join("");
}

interface RewriteInlineInput {
  source: string;
  literal: ArrayLiteral;
  added: readonly string[];
  lastEntry: Entry;
}

function rewriteInline(input: RewriteInlineInput): string {
  const { source, literal, added, lastEntry } = input;
  const tail = source.slice(lastEntry.end, literal.close);
  const hasTrailingComma = findTrailingCommaIndex(tail) !== -1;
  const inserts = added.map((value) => wrapInQuotes(value)).join(", ");
  const insertion = hasTrailingComma ? [" ", inserts, ","].join("") : [", ", inserts].join("");
  return [source.slice(0, literal.close), insertion, source.slice(literal.close)].join("");
}

interface RewriteMultiLineInput {
  source: string;
  literal: ArrayLiteral;
  added: readonly string[];
  firstEntry: Entry;
  lastEntry: Entry;
  lineEnd: string;
}

function rewriteMultiLine(input: RewriteMultiLineInput): string {
  const { source, literal, added, firstEntry, lastEntry, lineEnd } = input;
  const tail = source.slice(lastEntry.end, literal.close);
  const hasTrailingComma = findTrailingCommaIndex(tail) !== -1;
  const entryIndent = detectEntryIndent(source, firstEntry);

  let mutated = source;
  let closeIndex = literal.close;
  if (!hasTrailingComma) {
    mutated = [mutated.slice(0, lastEntry.end), ",", mutated.slice(lastEntry.end)].join("");
    closeIndex += 1;
  }

  const closeLineStart = mutated.lastIndexOf("\n", closeIndex - 1) + 1;
  const insertion = added
    .map((value) => [entryIndent, wrapInQuotes(value), ",", lineEnd].join(""))
    .join("");
  return [mutated.slice(0, closeLineStart), insertion, mutated.slice(closeLineStart)].join("");
}

function detectOuterIndent(source: string, literal: ArrayLiteral): string {
  const lineStart = source.lastIndexOf("\n", literal.open - 1) + 1;
  const match = LEADING_WHITESPACE.exec(source.slice(lineStart));
  /* v8 ignore next @preserve -- LEADING_WHITESPACE matches the empty string, so exec never returns null here; the fallback exists for type-narrowing only. */
  return match?.[0] ?? "";
}

function detectEntryIndent(source: string, firstEntry: Entry): string {
  const lineStart = source.lastIndexOf("\n", firstEntry.start - 1) + 1;
  const leading = source.slice(lineStart, firstEntry.start);
  /* v8 ignore else @preserve -- the else branch handles the unusual case where the first entry shares a line with the open bracket; the writer otherwise routes through rewriteInline. */
  if (ONLY_WHITESPACE.test(leading)) {
    return leading;
  }
  // companion to the v8-ignored else branch above.
  /* v8 ignore start @preserve */
  const outerLine = source.lastIndexOf("\n", lineStart - 2) + 1;
  const outerLeading = LEADING_WHITESPACE.exec(source.slice(outerLine));
  const outerIndent = outerLeading === null ? "" : outerLeading[0];
  return [outerIndent, "  "].join("");
  /* v8 ignore stop */
}

function findTrailingCommaIndex(tail: string): number {
  for (let index = 0; index < tail.length; index += 1) {
    const ch = tail.charAt(index);
    if (ch === ",") {
      return index;
    }
    /* v8 ignore next 3 @preserve -- tail spans lastEntry.end to the close bracket, so non-comma non-whitespace would require malformed source we don't try to repair. */
    if (ANY_NON_WHITESPACE.test(ch)) {
      return -1;
    }
  }
  return -1;
}

function wrapInQuotes(value: string): string {
  return JSON.stringify(value);
}

function writeAtomically(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}
