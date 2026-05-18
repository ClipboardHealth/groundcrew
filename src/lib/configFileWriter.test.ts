import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { updateKnownRepositoriesInConfigFile } from "./configFileWriter.ts";

vi.mock(import("node:fs"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renameSync: vi.fn<typeof actual.renameSync>(actual.renameSync),
  };
});

const renameSyncMock = vi.mocked(renameSync);

let dir: string;
let configPath: string;

function write(content: string): void {
  writeFileSync(configPath, content);
}

function read(): string {
  return readFileSync(configPath, "utf8");
}

describe(updateKnownRepositoriesInConfigFile, () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "groundcrew-config-writer-"));
    configPath = join(dir, "config.ts");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("appends a new entry to a multi-line array with a trailing comma", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = updateKnownRepositoriesInConfigFile({
      configPath,
      toAdd: ["owner/b"],
    });

    expect(result).toStrictEqual({ added: ["owner/b"], alreadyPresent: [] });
    expect(read()).toBe(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        '      "owner/b",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  });

  it("inserts a trailing comma when the previous last entry lacked one", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a"',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toBe(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        '      "owner/b",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  });

  it("uses the dominant entry indent from existing entries", () => {
    write(
      [
        "export const config = {",
        "\tworkspace: {",
        "\t\tknownRepositories: [",
        '\t\t\t"owner/a",',
        "\t\t],",
        "\t},",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('\t\t\t"owner/b",\n');
  });

  it("preserves interleaved // and /* */ comments inside the array", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        "      // top",
        '      "owner/a",',
        "      /* mid */",
        '      "owner/b",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/c"] });

    const after = read();
    expect(after).toContain("// top");
    expect(after).toContain("/* mid */");
    expect(after).toContain('"owner/a",');
    expect(after).toContain('"owner/b",');
    expect(after).toContain('"owner/c",');
  });

  it("expands an empty array to multi-line shape when adding several entries", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({
      configPath,
      toAdd: ["owner/a", "owner/b"],
    });

    expect(read()).toBe(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        '      "owner/b",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  });

  it("keeps an empty array inline when adding a single entry", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/a"] });

    expect(read()).toContain('knownRepositories: ["owner/a"],');
  });

  it("inserts into a single-line non-empty array with a trailing comma", () => {
    write(
      [
        "export const config = {",
        '  workspace: { knownRepositories: ["owner/a",] },',
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('knownRepositories: ["owner/a", "owner/b",]');
  });

  it("preserves CRLF line endings when adding entries", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\r\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('"owner/b",\r\n');
  });

  it("handles a config file ending with a line comment and no trailing newline", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        "    ],",
        "  },",
        "};",
        "// trailing comment without newline",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('"owner/b",');
    expect(read()).toContain("// trailing comment without newline");
  });

  it("inserts into a single-line non-empty array preserving the same shape", () => {
    write(
      [
        "export const config = {",
        '  workspace: { knownRepositories: ["owner/a"] },',
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('knownRepositories: ["owner/a", "owner/b"]');
  });

  it("does not rewrite the file when every entry to add is already present", () => {
    const original = [
      "export const config = {",
      "  workspace: {",
      "    knownRepositories: [",
      '      "owner/a",',
      "    ],",
      "  },",
      "};",
      "",
    ].join("\n");
    write(original);

    const result = updateKnownRepositoriesInConfigFile({
      configPath,
      toAdd: ["owner/a"],
    });

    expect(result).toStrictEqual({ added: [], alreadyPresent: ["owner/a"] });
    expect(read()).toBe(original);
  });

  it("throws when the `knownRepositories` array literal cannot be found", () => {
    write(["export const config = {", "  workspace: { projectDir: '/tmp' },", "};", ""].join("\n"));

    expect(() => updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/a"] })).toThrow(
      /couldn't find/,
    );
  });

  it("ignores `knownRepositories` mentions that appear inside comments and strings", () => {
    write(
      [
        "// knownRepositories: [bogus]",
        '/* knownRepositories: ["nope"] */',
        String.raw`const fakeDoc = "knownRepositories: [\"x\"]";`,
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/real",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/added"] });

    const after = read();
    expect(after).toContain('"owner/real",');
    expect(after).toContain('"owner/added",');
    expect(after).toContain("// knownRepositories: [bogus]");
  });

  it("throws when two real `knownRepositories` array literals exist", () => {
    write(
      [
        "export const a = { knownRepositories: ['x'] };",
        "export const b = { knownRepositories: ['y'] };",
        "",
      ].join("\n"),
    );

    expect(() => updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/a"] })).toThrow(
      /multiple .*knownRepositories/,
    );
  });

  it("reads single-quoted entries and writes back as double-quoted", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        "      'owner/a',",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = updateKnownRepositoriesInConfigFile({
      configPath,
      toAdd: ["owner/a", "owner/b"],
    });

    expect(result).toStrictEqual({ added: ["owner/b"], alreadyPresent: ["owner/a"] });
    expect(read()).toContain('"owner/b",');
  });

  it("reads backtick-quoted entries with no interpolation", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        "      `owner/a`,",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/a"] });

    expect(result).toStrictEqual({ added: [], alreadyPresent: ["owner/a"] });
  });

  it("rejects template literals with interpolation in knownRepositories", () => {
    write(
      [
        "const owner = 'foo';",
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        // oxlint-disable-next-line no-template-curly-in-string -- intentional: the test fixture contains a template-literal interpolation as a string for the writer to reject.
        "      `${owner}/a`,",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    expect(() => updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] })).toThrow(
      /template literals with interpolation/,
    );
  });

  it("rejects non-string-literal entries (e.g. `null`)", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        "      null,",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    expect(() => updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/a"] })).toThrow(
      /unexpected token .* only string literals/,
    );
  });

  it("treats a nested `[...]` inside the array body as part of the same literal", () => {
    write(
      [
        "export const config = {",
        "  workspace: {",
        '    knownRepositories: ["owner/a", ["nested"], "owner/b"],',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    expect(() => updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/c"] })).toThrow(
      /unexpected token .* only string literals/,
    );
  });

  it("skips `knownRepositories` identifiers used in non-array-assignment positions", () => {
    write(
      [
        "let knownRepositories;",
        "function readKnownRepositories(): string[] { return []; }",
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('"owner/a",');
    expect(read()).toContain('"owner/b",');
  });

  it("skips `knownRepositories:` followed by a non-array value", () => {
    write(
      [
        "const fakeType = { knownRepositories: 0 };",
        "export const config = {",
        "  workspace: {",
        "    knownRepositories: [",
        '      "owner/a",',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] });

    expect(read()).toContain('"owner/b",');
  });

  it("leaves the original file unmodified when the atomic rename fails", () => {
    const original = [
      "export const config = {",
      "  workspace: {",
      "    knownRepositories: [",
      '      "owner/a",',
      "    ],",
      "  },",
      "};",
      "",
    ].join("\n");
    write(original);

    renameSyncMock.mockImplementationOnce(() => {
      throw new Error("rename failed");
    });

    expect(() => updateKnownRepositoriesInConfigFile({ configPath, toAdd: ["owner/b"] })).toThrow(
      /rename failed/,
    );
    expect(read()).toBe(original);
  });
});
