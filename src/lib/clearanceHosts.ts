/**
 * Translate the existing clearance egress allowlist into srt
 * `network.allowedDomains`. groundcrew keeps one source of truth for which
 * hosts an agent may reach: the `CLEARANCE_ALLOW_HOSTS` env var and the
 * newline-delimited files named by `CLEARANCE_ALLOW_HOSTS_FILES` (the shipped
 * `clearance-allow-hosts` starter plus any personal files).
 *
 * clearance and srt share host-matching semantics — a bare `example.com` is an
 * exact match and `*.example.com` matches subdomains — so the translation is
 * almost an identity. The only real work is parsing (comments, blanks,
 * comma/whitespace/newline separators), de-duplication, and dropping entries
 * srt's domain schema would reject (`*.com`, `*`, leading/trailing dots, bare
 * tokens without a dot like `localhost`) so the generated settings file always
 * validates.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { debug } from "./util.ts";

export interface CollectAllowedDomainsInput {
  /** Raw `CLEARANCE_ALLOW_HOSTS` value (comma/whitespace separated). */
  hosts?: string | undefined;
  /**
   * Raw `CLEARANCE_ALLOW_HOSTS_FILES` value: a list of file paths joined by
   * the platform path delimiter (`:` on POSIX), each a newline-delimited host
   * list. Missing or unreadable files are skipped with a debug line.
   */
  files?: string | undefined;
}

/**
 * Parse and validate clearance allow-host sources into a de-duplicated list of
 * srt domain patterns, preserving first-seen order.
 */
export function collectAllowedDomains(input: CollectAllowedDomainsInput): string[] {
  const texts: string[] = [];
  for (const file of splitPathList(input.files)) {
    try {
      texts.push(readFileSync(file, "utf8"));
    } catch (error) {
      debug(`Skipping unreadable CLEARANCE_ALLOW_HOSTS_FILES entry ${file}: ${String(error)}`);
    }
  }
  if (input.hosts !== undefined) {
    texts.push(input.hosts);
  }

  const seen = new Set<string>();
  const domains: string[] = [];
  for (const text of texts) {
    for (const raw of tokenize(text)) {
      const domain = normalizeDomain(raw);
      if (domain === undefined) {
        continue;
      }
      const key = domain.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      domains.push(domain);
    }
  }
  return domains;
}

function splitPathList(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Split a host source into candidate tokens. Handles env-style
 * comma/whitespace separators and file-style newline lists with `#` comments
 * (full-line or trailing — hostnames never contain `#`).
 */
function tokenize(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.replace(/#.*$/, "").split(/[\s,]+/))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Normalize a raw host token into a valid srt domain pattern, or `undefined`
 * if srt would reject it. Mirrors srt's `DomainPatternSchema`: a wildcard must
 * be `*.<domain-with-a-dot>`; a bare host must contain a dot and no `*`. A
 * leading-dot suffix form (`.example.com`) is rewritten to `*.example.com`.
 */
function normalizeDomain(token: string): string | undefined {
  const candidate = token.startsWith(".") ? `*${token}` : token;

  if (candidate.startsWith("*.")) {
    const base = candidate.slice(2);
    return isPlainDomain(base) ? candidate : undefined;
  }
  return isPlainDomain(candidate) ? candidate : undefined;
}

function isPlainDomain(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("*") &&
    // Mirror srt's DomainPatternSchema, which rejects scheme/path/port tokens.
    // This matters for safety, not just correctness: a token srt rejects (e.g.
    // `https://api.github.com`, `api.github.com:443`, `github.com/path`) fails
    // the whole settings file's schema validation, and srt's `loadConfig` then
    // returns null → the CLI silently falls back to a config with no read mask.
    // Dropping such tokens here keeps the generated settings valid (fail closed
    // for that host, never fail open for the launch).
    !value.includes("://") &&
    !value.includes("/") &&
    !value.includes(":") &&
    value.includes(".") &&
    !value.startsWith(".") &&
    !value.endsWith(".")
  );
}
