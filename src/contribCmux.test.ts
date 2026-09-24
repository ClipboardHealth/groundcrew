import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIDEBAR_PATH = new URL("../contrib/cmux/groundcrew.swift", import.meta.url);
const INSTALLER_PATH = new URL("../contrib/cmux/install.sh", import.meta.url);
const REPOSITORY_PATH = fileURLToPath(new URL("..", import.meta.url));

function stateRankIn(source: string, state: string): number {
  const match = source.match(new RegExp(`if s == "${state}" \\{\\s*return (\\d+)`, "u"));
  return match ? Number(match[1]) : 0;
}

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

  it("distinguishes agent runtimes so claude and codex are told apart", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const iconSource = actual.slice(
      actual.indexOf("func agentIcon"),
      actual.indexOf("func agentColor"),
    );

    const icons = [...iconSource.matchAll(/return "[^"]+"/gu)].map((match) => match[0]);

    expect(iconSource).toContain('k.contains("claude")');
    expect(iconSource).toContain('k.contains("codex")');
    expect(icons.length).toBeGreaterThan(1);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("renders one row per agent session rather than merging them", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain("stateIcon(effectiveStatus(a, now))");
    expect(actual).toContain("help(agentTooltip(a, now))");
  });

  it("collapses registry records that share a pid into one row", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const dedupeSource = actual.slice(
      actual.indexOf("func stateRank"),
      actual.indexOf("func agentName"),
    );

    expect(dedupeSource).toContain('return "pid:" + String(p)');
    expect(dedupeSource).toContain('return "id:" + a.id');
    expect(actual).toContain("ForEach(distinctAgents(ags, now)) { a in");
    expect(actual).not.toContain("ForEach(ags) { a in");
  });

  it("keeps the freshest record when duplicates of one process disagree", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const dedupeSource = actual.slice(
      actual.indexOf("func stateRank"),
      actual.indexOf("func agentName"),
    );

    // The abandoned duplicate is the one that stopped receiving hook events,
    // and it keeps whatever state it froze in -- routinely "working". Ranking
    // by state alone therefore pins the row to working forever, so the survivor
    // has to be chosen by last activity, with rank breaking ties only between
    // equally recent records.
    expect(dedupeSource).toContain("let newest = newestActivityForKey(list, key)");
    expect(dedupeSource).toContain("activityAt(b) == newest");
    expect(dedupeSource).toContain("bestAgentIdForKey(list, agentKey(a), now) == a.id");
    expect(stateRankIn(dedupeSource, "needs_input")).toBeGreaterThan(
      stateRankIn(dedupeSource, "working"),
    );
    expect(stateRankIn(dedupeSource, "working")).toBeGreaterThan(stateRankIn(dedupeSource, "idle"));
    expect(stateRankIn(dedupeSource, "idle")).toBeGreaterThan(stateRankIn(dedupeSource, "ended"));
  });

  it("demotes an active state that has gone silent for hours", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const staleSource = actual.slice(
      actual.indexOf("func effectiveStatus"),
      actual.indexOf("func ageLabel"),
    );

    // A process that dies mid-turn never reports a terminal state, so its
    // record reads "working" indefinitely. The longest gap between hook events
    // inside a live codex session measured 34 minutes, so the silence window
    // has to stay well clear of that to avoid demoting a busy agent.
    expect(staleSource).toContain("activeState(a.status)");
    expect(staleSource).toContain('return "stale"');
    const windowSeconds = /silentSeconds\(a, now\) > (\d+)/u.exec(staleSource)?.[1];
    expect(Number(windowSeconds)).toBeGreaterThanOrEqual(7200);
    expect(actual).toContain('return "no signal"');
  });

  it("falls back to the native status pill when no agents are reported", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const gateSource = actual.slice(
      actual.indexOf("func showsNativeStatus"),
      actual.indexOf("func isTask"),
    );

    expect(gateSource).toContain("if hasAgents(w) {");
    expect(gateSource).toContain("return false");
    expect(actual).toContain("if showsNativeStatus(w) {");
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
