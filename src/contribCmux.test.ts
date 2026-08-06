import { readFileSync } from "node:fs";

const SIDEBAR_PATH = new URL("../contrib/cmux/groundcrew.swift", import.meta.url);
const INSTALLER_PATH = new URL("../contrib/cmux/install.sh", import.meta.url);

describe("cmux contrib sidebar", () => {
  it("validates raw ticket prefixes before Unicode normalization", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain('replacingOccurrences(of: "a", with: "")');
    expect(actual).toContain('replacingOccurrences(of: "z", with: "")');
    expect(actual).toContain("isAlphaOnly(segs[segs.count - 2])");
    expect(actual).toContain("isAlphaOnly(segs[0])");
    expect(actual).not.toContain("isAlphaOnly(segs[0].uppercased())");
  });

  it("preserves the dirty-worktree guard during cleanup", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).not.toContain('crew cleanup " + task + " --force');
  });

  it("reports success only after cleanup succeeds", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain(
      'crew cleanup " + task + " && { cmux workspace close " + w.id + "; echo; echo \'✓ cleanup finished — close this tab when done\'; }"',
    );
  });

  it("uses collision-resistant sidebar backup names", () => {
    const actual = readFileSync(INSTALLER_PATH, "utf8");

    expect(actual).toContain(`backup="\${target}.$(date +%Y%m%d%H%M%S).$$.bak"`);
  });
});
