import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { latestAgentLogPath, removeAgentLogsForTicket } from "./agentLog.ts";
import type { ResolvedConfig } from "./config.ts";
import { writeError } from "./util.ts";

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeError: vi.fn<typeof actual.writeError>() };
});

function makeConfig(agentLogDir: string | false): ResolvedConfig {
  return {
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: { default: "claude", definitions: { claude: { cmd: "claude", color: "#fff" } } },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log", agentLogDir },
  };
}

describe(removeAgentLogsForTicket, () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "groundcrew-removeAgentLogs-"));
    vi.mocked(writeError).mockClear();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    vi.mocked(writeError).mockClear();
  });

  it("removes the ticket's timestamped logs and its latest symlink", () => {
    writeFileSync(join(sandbox, "team-1-20260517-150234.log"), "a");
    writeFileSync(join(sandbox, "team-1-20260517-150300.log"), "b");
    symlinkSync("team-1-20260517-150300.log", join(sandbox, "team-1.log"));

    removeAgentLogsForTicket(makeConfig(sandbox), "team-1");

    expect(readdirSync(sandbox)).toHaveLength(0);
  });

  it("leaves other tickets' logs untouched (no prefix collision)", () => {
    writeFileSync(join(sandbox, "team-1-20260517-150234.log"), "x");
    symlinkSync("team-1-20260517-150234.log", join(sandbox, "team-1.log"));
    writeFileSync(join(sandbox, "team-10-20260517-150234.log"), "x");
    symlinkSync("team-10-20260517-150234.log", join(sandbox, "team-10.log"));
    writeFileSync(join(sandbox, "groundcrew.log"), "x");
    // Same ticket prefix but not a launch-log timestamp — leave it alone.
    writeFileSync(join(sandbox, "team-1-draft.log"), "x");

    removeAgentLogsForTicket(makeConfig(sandbox), "team-1");

    expect(readdirSync(sandbox).toSorted()).toStrictEqual(
      [
        "groundcrew.log",
        "team-1-draft.log",
        "team-10-20260517-150234.log",
        "team-10.log",
      ].toSorted(),
    );
  });

  it("does nothing when capture is disabled (agentLogDir false)", () => {
    removeAgentLogsForTicket(makeConfig(false), "team-1");

    expect(vi.mocked(writeError)).not.toHaveBeenCalled();
  });

  it("does nothing when the log directory does not exist", () => {
    removeAgentLogsForTicket(makeConfig(join(sandbox, "nope")), "team-1");

    expect(vi.mocked(writeError)).not.toHaveBeenCalled();
  });

  it("warns and continues when a matching entry cannot be removed", () => {
    writeFileSync(join(sandbox, "team-1-20260517-150234.log"), "x");
    // A non-empty directory named like a log file: rmSync (non-recursive) throws.
    const blocker = join(sandbox, "team-1-20260517-150300.log");
    mkdirSync(blocker);
    writeFileSync(join(blocker, "child"), "x");

    removeAgentLogsForTicket(makeConfig(sandbox), "team-1");

    expect(readdirSync(sandbox)).toStrictEqual(["team-1-20260517-150300.log"]);
    expect(vi.mocked(writeError)).toHaveBeenCalledTimes(1);
  });
});

describe(latestAgentLogPath, () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "groundcrew-latestAgentLog-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns the <ticket>.log symlink path when a captured log exists", () => {
    writeFileSync(join(sandbox, "team-1-20260517-150234.log"), "x");
    symlinkSync("team-1-20260517-150234.log", join(sandbox, "team-1.log"));

    expect(latestAgentLogPath(makeConfig(sandbox), "team-1")).toBe(join(sandbox, "team-1.log"));
  });

  it("returns undefined when no log exists for the ticket", () => {
    expect(latestAgentLogPath(makeConfig(sandbox), "team-1")).toBeUndefined();
  });

  it("returns undefined when capture is disabled", () => {
    expect(latestAgentLogPath(makeConfig(false), "team-1")).toBeUndefined();
  });
});
