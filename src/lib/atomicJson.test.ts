import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./atomicJson.ts";

describe(writeJsonAtomic, () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "groundcrew-atomic-json-"));
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("removes the temporary file when atomic replacement fails", () => {
    const targetPath = path.join(temporaryDirectory, "target");
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    mkdirSync(targetPath);

    expect(() => {
      writeJsonAtomic(targetPath, { ok: true });
    }).toThrow(expect.objectContaining({ syscall: "rename" }));

    expect(existsSync(temporaryPath)).toBe(false);
  });
});
