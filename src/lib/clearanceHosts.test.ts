import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectAllowedDomains } from "./clearanceHosts.ts";

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, debug: vi.fn<typeof actual.debug>() };
});

describe(collectAllowedDomains, () => {
  it("parses comma/whitespace-separated CLEARANCE_ALLOW_HOSTS into domains", () => {
    const actual = collectAllowedDomains({ hosts: "api.openai.com, api.anthropic.com github.com" });

    expect(actual).toStrictEqual(["api.openai.com", "api.anthropic.com", "github.com"]);
  });

  it("keeps wildcard patterns and rewrites a leading-dot suffix to a wildcard", () => {
    const actual = collectAllowedDomains({ hosts: "*.npmjs.org .github.com" });

    expect(actual).toStrictEqual(["*.npmjs.org", "*.github.com"]);
  });

  it("drops entries srt's domain schema rejects", () => {
    const actual = collectAllowedDomains({ hosts: "*.com * localhost trailing. github.com" });

    expect(actual).toStrictEqual(["github.com"]);
  });

  it("drops scheme/port/path tokens that would fail srt validation and disable the sandbox", () => {
    const actual = collectAllowedDomains({
      hosts: "https://api.github.com api.github.com:443 github.com/path api.github.com",
    });

    // Only the bare host survives; the malformed forms are dropped rather than
    // emitted (a token srt rejects would null its whole settings file → no mask).
    expect(actual).toStrictEqual(["api.github.com"]);
  });

  it("de-duplicates case-insensitively, preserving first-seen order", () => {
    const actual = collectAllowedDomains({ hosts: "github.com API.GITHUB.COM github.com" });

    expect(actual).toStrictEqual(["github.com", "API.GITHUB.COM"]);
  });

  it("reads newline-delimited files, skipping comments and blank lines", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clearance-hosts-"));
    const file = path.join(dir, "allow-hosts");
    writeFileSync(
      file,
      "# AI APIs\napi.anthropic.com\n\nregistry.npmjs.org # inline comment\n",
      "utf8",
    );

    try {
      const actual = collectAllowedDomains({ files: file });

      expect(actual).toStrictEqual(["api.anthropic.com", "registry.npmjs.org"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges files then env hosts and skips unreadable file entries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clearance-hosts-"));
    const file = path.join(dir, "allow-hosts");
    writeFileSync(file, "api.linear.app\n", "utf8");
    const missing = path.join(dir, "does-not-exist");

    try {
      const actual = collectAllowedDomains({
        files: `${file}${path.delimiter}${missing}`,
        hosts: "api.openai.com",
      });

      expect(actual).toStrictEqual(["api.linear.app", "api.openai.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when nothing is configured", () => {
    expect(collectAllowedDomains({})).toStrictEqual([]);
  });
});
