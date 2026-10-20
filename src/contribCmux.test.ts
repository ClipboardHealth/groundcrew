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
  // Ticket-prefix validation (alpha-only prefix, exact two-segment title
  // match) used to live here as Swift string assertions. The sidebar no
  // longer parses tickets at all -- it reads the `crew_ticket` status
  // pr-stage-sync writes -- and that derivation logic, including these same
  // rules, now lives in `src/lib/prStageRules.ts` with its own 8-case fixture
  // suite (`deriveTicket` in `prStageRules.test.ts`).
  it("reads crew_ticket instead of re-deriving it from title or directory", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain('e.key == "crew_ticket"');
    expect(actual).not.toContain("func ticketFromDirectory");
    expect(actual).not.toContain("func ticketFromTitle");
    expect(actual).not.toContain("func isAlphaOnly");
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

  it("renders one deduped icon per agent session instead of a per-agent state row", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain("ForEach(liveAgents) { a in agentIconView(a, now, pulse) }");
    expect(actual).toContain(".help(tooltip)");
  });

  it("collapses registry records that share a pid into one row", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const dedupeSource = actual.slice(
      actual.indexOf("func stateRank"),
      actual.indexOf("func liveAgentsOf"),
    );

    expect(dedupeSource).toContain('return "pid:" + String(p)');
    expect(dedupeSource).toContain('return "id:" + a.id');
    expect(actual).toContain("return distinctAgents(ags, now)");
    expect(actual).not.toContain("ForEach(ags) { a in");
    expect(actual).not.toContain("ForEach(w.agents)");
  });

  it("keeps the freshest record when duplicates of one process disagree", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const dedupeSource = actual.slice(
      actual.indexOf("func stateRank"),
      actual.indexOf("func liveAgentsOf"),
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
    expect(staleSource).toContain('return "stale"');
    expect(actual).toContain('return "no signal"');

    // Pinned exactly: widening the window to a day would pass a lower bound
    // while restoring the "working forever" symptom in practice.
    const windowSeconds = /silentSeconds\(a, now\) > (\d+)/u.exec(staleSource)?.[1];
    expect(Number(windowSeconds)).toBe(7200);
  });

  it("never demotes an agent that is waiting on the user", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const staleSource = actual.slice(
      actual.indexOf("func effectiveStatus"),
      actual.indexOf("func ageLabel"),
    );
    const executingSource = actual.slice(
      actual.indexOf("func executingState"),
      actual.indexOf("func activityAt"),
    );

    // needs_input waits on a person, so silence there is expected rather than
    // evidence of an abandoned record. Demoting it would hide the one state
    // that requires the user to act, so the window keys off execution states
    // only and must not reach for the broader activeState.
    expect(staleSource).toContain("executingState(a.status)");
    expect(staleSource).not.toContain("activeState(a.status)");
    expect(executingSource).not.toContain("needs_input");
  });

  it("counts a workspace as a task from crew_ticket alone, with no native status pill rendered", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const isTaskSource = actual.slice(
      actual.indexOf("func isTask"),
      actual.indexOf("func isWorkbench"),
    );

    expect(isTaskSource).toContain('if crewTicket(w) != "" {');
    expect(actual).not.toContain("func showsNativeStatus");
    expect(actual).not.toContain("rowStateValue");
  });

  it("defaults PR links to GitHub", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const targetSource = actual.slice(
      actual.indexOf("func prLinkTarget"),
      actual.indexOf("func prLink("),
    );

    expect(targetSource).toContain('return "github"');
  });

  it("toggles labels and refreshes stages through crew stage, not the retired crew-pr-stages poller", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const commandSource = actual.slice(
      actual.indexOf("func labelToggleCommand"),
      actual.indexOf("func taskRow"),
    );

    expect(commandSource).toContain('crew stage " + verb');
    expect(commandSource).toContain("echo '→ crew stage refresh'; crew stage refresh");
    expect(commandSource).not.toContain("crew-pr-stages");
    expect(commandSource).not.toContain("~/.config/cmux/bin");
  });

  it("runs the label toggle and refresh actions from the __GROUNDCREW_DIR__ placeholder install.sh substitutes", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");

    expect(actual).toContain('func crewStagesCwd() -> String {\n  return "__GROUNDCREW_DIR__"');
    expect(actual).toContain("cwd: crewStagesCwd()");
  });

  it("hides the stale caption and renames the unknown-stage section when PR-stage sync has never run", () => {
    const actual = readFileSync(SIDEBAR_PATH, "utf8");
    const staleSource = actual.slice(
      actual.indexOf("func stagesStale"),
      actual.indexOf("func stageBadgeColor"),
    );

    expect(actual).toContain("func anyHeartbeatSeen");
    expect(staleSource).toContain("if !stagesEverRun {");
    expect(actual).toContain('let unknownTitle = stagesEverRun ? "Stage unknown" : "Open PRs"');
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
