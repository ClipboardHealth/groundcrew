import { describeFileError, fileErrorCode, isFileErrorCode } from "./fileErrors.ts";

describe("todo-txt file error helpers", () => {
  it("extracts filesystem error codes", () => {
    const error = Object.assign(new Error("blocked"), { code: "EPERM" });

    expect(fileErrorCode(error)).toBe("EPERM");
    expect(isFileErrorCode(error, "EPERM")).toBe(true);
    expect(isFileErrorCode(error, "ENOENT")).toBe(false);
  });

  it("describes filesystem errors with their code", () => {
    const error = Object.assign(new Error("blocked"), { code: "EPERM" });

    expect(describeFileError(error)).toBe("EPERM: blocked");
  });

  it("falls back for non-filesystem throws", () => {
    expect(fileErrorCode("blocked")).toBeUndefined();
    expect(describeFileError("blocked")).toBe("blocked");
  });
});
