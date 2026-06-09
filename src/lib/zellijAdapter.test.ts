import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import type * as utilModule from "./util.ts";
import { setLogFile } from "./util.ts";
import { zellijAdapter } from "./zellijAdapter.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shared sync/async recorder
    runCommandAsync: runMock as unknown as typeof actual.runCommandAsync,
  };
});

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    log: vi.fn<typeof actual.log>(),
    debug: vi.fn<typeof actual.debug>(),
  };
});

const NEW_TAB = "new-tab";
const LIST_SESSIONS = "list-sessions";
const QUERY = "query-tab-names";
const ATTACH = "attach";
const CLOSE_BY_ID = "close-tab-by-id";
const DELETE = "delete-session";

// Module-scope routers so per-call branching stays out of test bodies.
function routeOk(values: Record<string, string>): RunCommandMock {
  return (_command, arguments_) => {
    for (const [needle, value] of Object.entries(values)) {
      if (arguments_.includes(needle)) {
        return value;
      }
    }
    return "";
  };
}

function routeThrow(
  needle: string,
  error: Error,
  others: Record<string, string> = {},
): RunCommandMock {
  return (_command, arguments_) => {
    if (arguments_.includes(needle)) {
      throw error;
    }
    for (const [other, value] of Object.entries(others)) {
      if (arguments_.includes(other)) {
        return value;
      }
    }
    return "";
  };
}

function routeReprobe(secondListResult: string): RunCommandMock {
  let listCalls = 0;
  return (_command, arguments_) => {
    if (arguments_.includes(LIST_SESSIONS)) {
      listCalls += 1;
      return listCalls === 1 ? "" : secondListResult;
    }
    if (arguments_.includes(ATTACH)) {
      throw new Error("attach failed");
    }
    return "";
  };
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const spec = { name: "team-1", cwd: "/work/repo-a-team-1", command: "exec claude" };

describe("zellij workspace adapter", () => {
  let work: string;
  let tabDir: string;
  let exitDir: string;

  beforeEach(() => {
    runMock.mockReset().mockReturnValue("");
    work = mkdtempSync(path.join(tmpdir(), "zellij-adapter-test-"));
    tabDir = path.join(work, "tabs");
    exitDir = path.join(work, "exited");
    setEnvironmentVariable("GROUNDCREW_ZELLIJ_TAB_DIR", tabDir);
    setEnvironmentVariable("GROUNDCREW_ZELLIJ_EXIT_DIR", exitDir);
    setLogFile(undefined);
  });

  afterEach(() => {
    deleteEnvironmentVariable("GROUNDCREW_ZELLIJ_TAB_DIR");
    deleteEnvironmentVariable("GROUNDCREW_ZELLIJ_EXIT_DIR");
    setLogFile(undefined);
    rmSync(work, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  function writeTabId(name: string, id: string): void {
    mkdirSync(tabDir, { recursive: true });
    writeFileSync(path.join(tabDir, name), id);
  }

  describe("accessHint", () => {
    it("returns the session attach command", () => {
      expect(zellijAdapter.accessHint("team-1")).toStrictEqual({
        kind: "attachCommand",
        command: "zellij attach groundcrew",
      });
    });
  });

  describe("open", () => {
    it("reuses an active session and records the new tab id", async () => {
      runMock.mockImplementation(
        routeOk({ [LIST_SESSIONS]: "groundcrew [Created]", [NEW_TAB]: "7" }),
      );

      await zellijAdapter.open(spec);

      expect(runMock).not.toHaveBeenCalledWith("zellij", expect.arrayContaining([ATTACH]));
      expect(runMock).toHaveBeenCalledWith(
        "zellij",
        expect.arrayContaining([NEW_TAB, "--name", "team-1", "--cwd", "/work/repo-a-team-1"]),
      );
    });

    it("creates a session when absent and tolerates an unparseable new-tab id", async () => {
      runMock.mockImplementation(routeOk({ [LIST_SESSIONS]: "", [NEW_TAB]: "no-number" }));

      await zellijAdapter.open(spec);

      expect(runMock).toHaveBeenCalledWith(
        "zellij",
        expect.arrayContaining([ATTACH, "--create-background", "groundcrew"]),
      );
    });

    it("drops a stale resurrectable session before creating", async () => {
      runMock.mockImplementation(
        routeOk({ [LIST_SESSIONS]: "groundcrew (EXITED - attach to resurrect)" }),
      );

      await zellijAdapter.open(spec);

      expect(runMock).toHaveBeenCalledWith("zellij", [DELETE, "groundcrew"]);
      expect(runMock).toHaveBeenCalledWith("zellij", expect.arrayContaining([ATTACH]));
    });

    it("continues past a failed stale-session delete", async () => {
      runMock.mockImplementation(
        routeThrow(DELETE, new Error("delete boom"), {
          [LIST_SESSIONS]: "groundcrew (EXITED - attach to resurrect)",
        }),
      );

      await zellijAdapter.open(spec);

      expect(runMock).toHaveBeenCalledWith("zellij", expect.arrayContaining([ATTACH]));
    });

    it("rethrows when the stale-session delete is aborted", async () => {
      runMock.mockImplementation(
        routeThrow(DELETE, new Error("delete boom"), {
          [LIST_SESSIONS]: "groundcrew (EXITED - attach to resurrect)",
        }),
      );

      await expect(zellijAdapter.open(spec, aborted())).rejects.toThrow("delete boom");
    });

    it("treats a session-state probe error as absent and creates", async () => {
      runMock.mockImplementation(routeThrow(LIST_SESSIONS, new Error("no sessions")));

      await zellijAdapter.open(spec);

      expect(runMock).toHaveBeenCalledWith("zellij", expect.arrayContaining([ATTACH]));
    });

    it("rethrows when the session-state probe is aborted", async () => {
      runMock.mockImplementation(routeThrow(LIST_SESSIONS, new Error("interrupted")));

      await expect(zellijAdapter.open(spec, aborted())).rejects.toThrow("interrupted");
    });

    it("rethrows when session creation is aborted", async () => {
      runMock.mockImplementation(routeThrow(ATTACH, new Error("create interrupted")));

      await expect(zellijAdapter.open(spec, aborted())).rejects.toThrow("create interrupted");
    });

    it("tolerates a creation race when a re-probe finds the session active", async () => {
      runMock.mockImplementation(routeReprobe("groundcrew [Created]"));

      await expect(zellijAdapter.open(spec)).resolves.toBeUndefined();
    });

    it("rethrows a creation failure when the re-probe still finds no session", async () => {
      runMock.mockImplementation(routeReprobe(""));

      await expect(zellijAdapter.open(spec)).rejects.toThrow("attach failed");
    });

    it("stages a log-tailing main pane when a log file is configured", async () => {
      runMock.mockImplementation(routeOk({ [LIST_SESSIONS]: "" }));
      setLogFile("/var/log/crew.log");

      await expect(zellijAdapter.open(spec)).resolves.toBeUndefined();
      expect(runMock).toHaveBeenCalledWith("zellij", expect.arrayContaining([ATTACH]));
    });

    it("swallows a failure to persist the tab id", async () => {
      // Point the tab-id dir under a regular file so the write throws.
      writeFileSync(path.join(work, "blocker"), "");
      setEnvironmentVariable("GROUNDCREW_ZELLIJ_TAB_DIR", path.join(work, "blocker", "tabs"));
      runMock.mockImplementation(
        routeOk({ [LIST_SESSIONS]: "groundcrew [Created]", [NEW_TAB]: "9" }),
      );

      await expect(zellijAdapter.open(spec)).resolves.toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns ticket tabs and marks the ones with exit markers", async () => {
      runMock.mockImplementation(routeOk({ [QUERY]: "main\ndevop-1\ndevop-2" }));
      await zellijAdapter.open({ ...spec, name: "devop-1" });
      mkdirSync(exitDir, { recursive: true });
      writeFileSync(path.join(exitDir, "devop-1"), "");

      await expect(zellijAdapter.list()).resolves.toStrictEqual([
        { name: "devop-1", state: "exited" },
        { name: "devop-2" },
      ]);
    });

    it("returns no workspaces when the session is missing", async () => {
      runMock.mockImplementation(routeThrow(QUERY, new Error("There is no active session!")));

      await expect(zellijAdapter.list()).resolves.toStrictEqual([]);
    });

    it("returns undefined when the query fails for an unknown reason", async () => {
      runMock.mockImplementation(routeThrow(QUERY, new Error("zellij exploded")));

      await expect(zellijAdapter.list()).resolves.toBeUndefined();
    });

    it("rethrows when the query is aborted", async () => {
      runMock.mockImplementation(routeThrow(QUERY, new Error("interrupted")));

      await expect(zellijAdapter.list(aborted())).rejects.toThrow("interrupted");
    });
  });

  describe("close", () => {
    it("closes the tab by its tracked id", async () => {
      writeTabId("team-1", "5");

      await expect(zellijAdapter.close("team-1")).resolves.toStrictEqual({ kind: "closed" });
      expect(runMock).toHaveBeenCalledWith("zellij", [
        "--session",
        "groundcrew",
        "action",
        CLOSE_BY_ID,
        "5",
      ]);
    });

    it("returns missing when no tab id is tracked", async () => {
      await expect(zellijAdapter.close("team-1")).resolves.toStrictEqual({ kind: "missing" });
    });

    it("ignores a non-integer id record", async () => {
      writeTabId("team-1", "not-a-number");

      await expect(zellijAdapter.close("team-1")).resolves.toStrictEqual({ kind: "missing" });
    });

    it("ignores an empty id record", async () => {
      writeTabId("team-1", "");

      await expect(zellijAdapter.close("team-1")).resolves.toStrictEqual({ kind: "missing" });
      expect(runMock).not.toHaveBeenCalledWith("zellij", expect.arrayContaining([CLOSE_BY_ID]));
    });

    it("falls back to the default tab-id dir when the env override is unset", async () => {
      deleteEnvironmentVariable("GROUNDCREW_ZELLIJ_TAB_DIR");

      await expect(zellijAdapter.close("unopened-ticket-xyz")).resolves.toStrictEqual({
        kind: "missing",
      });
    });

    it("returns missing when close-tab-by-id reports the session is gone", async () => {
      writeTabId("team-1", "5");
      runMock.mockImplementation(
        routeThrow(CLOSE_BY_ID, new Error("Session 'groundcrew' not found")),
      );

      await expect(zellijAdapter.close("team-1")).resolves.toStrictEqual({ kind: "missing" });
    });

    it("rethrows an unknown close failure", async () => {
      writeTabId("team-1", "5");
      runMock.mockImplementation(routeThrow(CLOSE_BY_ID, new Error("boom")));

      await expect(zellijAdapter.close("team-1")).rejects.toThrow("boom");
    });

    it("rethrows when the close is aborted", async () => {
      writeTabId("team-1", "5");
      runMock.mockImplementation(routeThrow(CLOSE_BY_ID, new Error("interrupted")));

      await expect(zellijAdapter.close("team-1", aborted())).rejects.toThrow("interrupted");
    });
  });
});
