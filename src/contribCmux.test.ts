import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIDEBAR_PATH = new URL("../contrib/cmux/groundcrew.swift", import.meta.url);
const INSTALLER_PATH = new URL("../contrib/cmux/install.sh", import.meta.url);
const REPOSITORY_PATH = fileURLToPath(new URL("..", import.meta.url));

describe("cmux contrib sidebar", () => {
  it("validates raw ticket prefixes before Unicode normalization", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain('replacingOccurrences(of: "a", with: "")');
    expect(actual).toContain('replacingOccurrences(of: "z", with: "")');
    expect(actual).toContain("isAlphaOnly(segs[segs.count - 2])");
    expect(actual).toContain("isAlphaOnly(segs[0])");
    expect(actual).not.toContain("isAlphaOnly(segs[0].uppercased())");
    expect(actual).not.toContain("isAlphaOnly(segs[segs.count - 2].uppercased())");
  });

  it("requires an exact ticket match in workspace titles", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const titleParserSource = actual.slice(
      actual.indexOf("func ticketFromTitle"),
      actual.indexOf("func ticketOf"),
    );

    expect(titleParserSource).toContain("if segs.count != 2 {");
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

  it("does not overwrite a pre-existing sidebar backup candidate", () => {
    const testHome = mkdtempSync(path.join(tmpdir(), "groundcrew-cmux-install-"));
    const commandDirectory = path.join(testHome, "bin");
    const cmuxPath = path.join(commandDirectory, "cmux");
    const datePath = path.join(commandDirectory, "date");
    mkdirSync(commandDirectory);
    writeFileSync(cmuxPath, "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(datePath, "#!/usr/bin/env bash\nprintf '20260101000000\\n'\n");
    chmodSync(cmuxPath, 0o755);
    chmodSync(datePath, 0o755);

    try {
      execFileSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
target="\${HOME}/.config/cmux/sidebars/groundcrew.swift"
mkdir -p "$(dirname "\${target}")"
printf 'current sidebar\\n' >"\${target}"
candidate="\${target}.20260101000000.$$.bak"
printf 'previous backup\\n' >"\${candidate}"
printf '%s' "\${candidate}" >"\${HOME}/candidate-path"
source "\${INSTALLER_PATH}"`,
        ],
        {
          env: {
            GROUNDCREW_DIR: REPOSITORY_PATH,
            HOME: testHome,
            INSTALLER_PATH: fileURLToPath(INSTALLER_PATH),
            PATH: `${commandDirectory}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
          },
        },
      );
      const candidatePath = readFileSync(path.join(testHome, "candidate-path"), "utf8");

      const actual = readFileSync(candidatePath, "utf8");

      expect(actual).toBe("previous backup\n");
    } finally {
      rmSync(testHome, { force: true, recursive: true });
    }
  });
});
