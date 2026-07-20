import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileSink } from "./fileSink.js";

describe("createFileSink", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "crew-filesink-"));
    filePath = path.join(directory, "nested", "groundcrew.jsonl");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates the parent directory and appends each line with a trailing newline", () => {
    const write = createFileSink({ filePath, maxBytes: 1024, maxFiles: 3 });

    write(`{"n":1}`);
    write(`{"n":2}`);

    const actual = fs.readFileSync(filePath, "utf8");
    expect(actual).toBe(`{"n":1}\n{"n":2}\n`);
  });

  it("rotates the active file into `.1` once it would exceed maxBytes", () => {
    const write = createFileSink({ filePath, maxBytes: 20, maxFiles: 3 });

    write("0123456789");
    write("abcdefghij");

    expect(fs.readFileSync(filePath, "utf8")).toBe("abcdefghij\n");
    expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("0123456789\n");
  });

  it("keeps only maxFiles files, shifting archives and dropping the oldest", () => {
    const write = createFileSink({ filePath, maxBytes: 12, maxFiles: 3 });

    write("aaaaaaaaaa");
    write("bbbbbbbbbb");
    write("cccccccccc");

    expect(fs.readFileSync(filePath, "utf8")).toBe("cccccccccc\n");
    expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("bbbbbbbbbb\n");
    expect(fs.readFileSync(`${filePath}.2`, "utf8")).toBe("aaaaaaaaaa\n");
    expect(fs.existsSync(`${filePath}.3`)).toBe(false);
  });

  it("truncates in place when maxFiles is 1 (no archives kept)", () => {
    const write = createFileSink({ filePath, maxBytes: 12, maxFiles: 1 });

    write("aaaaaaaaaa");
    write("bbbbbbbbbb");

    expect(fs.readFileSync(filePath, "utf8")).toBe("bbbbbbbbbb\n");
    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  });

  it("never rotates a single oversized line on an empty file", () => {
    const write = createFileSink({ filePath, maxBytes: 4, maxFiles: 3 });

    write("this line is longer than maxBytes");

    expect(fs.readFileSync(filePath, "utf8")).toBe("this line is longer than maxBytes\n");
    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  });
});
