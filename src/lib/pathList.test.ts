import path from "node:path";

import { splitPathList } from "./pathList.ts";

describe(splitPathList, () => {
  it("returns an empty array when the value is undefined", () => {
    const input = new Map<string, string>().get("missing");

    const actual = splitPathList(input);

    expect(actual).toStrictEqual([]);
  });

  it("returns one path when the value has no delimiter", () => {
    const actual = splitPathList("/tmp/allow-hosts");

    expect(actual).toStrictEqual(["/tmp/allow-hosts"]);
  });

  it("splits multiple paths on the platform delimiter", () => {
    const actual = splitPathList(`/tmp/team${path.delimiter}/tmp/personal`);

    expect(actual).toStrictEqual(["/tmp/team", "/tmp/personal"]);
  });

  it("trims whitespace and filters empty entries", () => {
    const actual = splitPathList(` /tmp/team ${path.delimiter} ${path.delimiter}/tmp/personal `);

    expect(actual).toStrictEqual(["/tmp/team", "/tmp/personal"]);
  });
});
