/**
 * Zellij Workspace backend. Workspaces live as named tabs inside one
 * dedicated `groundcrew` zellij session; the tab name is the ticket id and
 * the first tab (`main`) is a placeholder that keeps the session alive. This
 * is a Linux/WSL alternative to tmux: zellij is a stateful multiplexer, so it
 * restores screen + terminal modes (mouse reporting, alt-screen) on every
 * attach, and enables the mouse by default. Zellij can't paint status pills,
 * so `open` silently drops `spec.status`.
 *
 * Zellij quirks shape this adapter:
 *   1. Tab actions that target the *active* tab (`close-tab`, `go-to-tab-name`)
 *      silently no-op on a detached session with no attached client. Only
 *      `close-tab-by-id` works headlessly — so `open` captures the stable id
 *      that `new-tab` prints and persists a ticket -> id map for `close`.
 *   2. `new-tab --layout` resolves a *file path* (not an inline string) and a
 *      per-tab layout does not inherit the session's tab-bar/status-bar, so we
 *      stage an absolute-path KDL file that includes the bar plugins itself.
 *   3. There is no headless way to read a tab's command-exit state, so the
 *      agent command touches a marker file on exit that `list()` checks.
 *   4. Zellij resurrects serialized sessions on attach; `open` drops a stale
 *      resurrectable groundcrew session before creating a fresh one so dead
 *      agent tabs don't reappear.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type Adapter,
  isSignalAborted,
  runWorkspaceCommand,
  type Workspace,
} from "./workspaceAdapter.ts";
import {
  debug,
  errorMessage,
  getLogFile,
  getLogRunStartByte,
  readEnvironmentVariable,
} from "./util.ts";

const ZELLIJ_SESSION = "groundcrew";
// The placeholder first tab; filtered out of `list()` like tmux's idle window.
const ZELLIJ_MAIN_TAB = "main";

// Zellij sessions are per-user and die on reboot, matching tmpdir lifetime —
// so a tmpdir-backed ticket -> stable-tab-id record stays in sync with reality.
// One file per ticket (rather than a shared JSON map) avoids a read-modify-write
// that concurrent open/close calls could lose or truncate. Overridable via env
// so tests can isolate it.
function tabIdDir(): string {
  return (
    readEnvironmentVariable("GROUNDCREW_ZELLIJ_TAB_DIR") ??
    path.join(tmpdir(), "groundcrew-zellij-tabs")
  );
}

function tabIdPath(name: string): string {
  return path.join(tabIdDir(), name.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
}

// Zellij exposes no headless way to read a tab's command-exit state (dump-layout
// doesn't distinguish exited from running, current-tab-info needs a client). So
// the agent command touches a per-ticket marker when it exits on its own; a
// groundcrew-issued close kills the process before the marker is written.
function exitMarkerDir(): string {
  return (
    readEnvironmentVariable("GROUNDCREW_ZELLIJ_EXIT_DIR") ??
    path.join(tmpdir(), "groundcrew-zellij-exited")
  );
}

function exitMarkerPath(name: string): string {
  return path.join(exitMarkerDir(), name.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
}

function clearExitMarker(name: string): void {
  rmSync(exitMarkerPath(name), { force: true });
}

export const zellijAdapter: Adapter = {
  async open(spec, signal) {
    await ensureZellijSession(signal);
    clearExitMarker(spec.name);
    const layoutFile = stageTabLayout(spec.name, spec.command);
    const output = await runWorkspaceCommand(
      "zellij",
      [
        "--session",
        ZELLIJ_SESSION,
        "action",
        "new-tab",
        "--name",
        spec.name,
        "--cwd",
        spec.cwd,
        "--layout",
        layoutFile,
      ],
      signal,
    );
    const tabId = parseTabId(output);
    if (tabId === undefined) {
      debug(`zellij new-tab for ${spec.name} returned no parseable id: ${output}`);
    } else {
      rememberTabId(spec.name, tabId);
    }
    // Zellij can't paint status pills; spec.status is silently dropped.
  },
  async list(signal) {
    let output: string;
    try {
      output = await runWorkspaceCommand(
        "zellij",
        ["--session", ZELLIJ_SESSION, "action", "query-tab-names"],
        signal,
      );
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      // No groundcrew session => no workspaces (distinct from "couldn't ask").
      if (isZellijMissingError(error)) {
        return [];
      }
      debug(`zellij query-tab-names failed: ${errorMessage(error)}`);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined marks the workspace backend as unavailable.
      return undefined;
    }
    return parseTabNames(output).map((workspace) =>
      existsSync(exitMarkerPath(workspace.name))
        ? { name: workspace.name, state: "exited" }
        : workspace,
    );
  },
  async close(name, signal) {
    const tabId = lookupTabId(name);
    if (tabId === undefined) {
      // Without the stable id we can't `close-tab-by-id`, and the active-tab
      // close paths no-op headlessly. Treat as already gone.
      debug(`zellij close: no tracked tab id for ${name}; treating as missing`);
      clearExitMarker(name);
      return { kind: "missing" };
    }
    try {
      await runWorkspaceCommand(
        "zellij",
        ["--session", ZELLIJ_SESSION, "action", "close-tab-by-id", String(tabId)],
        signal,
      );
      forgetTabId(name);
      clearExitMarker(name);
      return { kind: "closed" };
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      if (isZellijMissingError(error)) {
        forgetTabId(name);
        clearExitMarker(name);
        return { kind: "missing" };
      }
      throw error;
    }
  },
  accessHint(_name) {
    // Zellij attaches at the session level; the user clicks the ticket's tab.
    return { kind: "attachCommand", command: `zellij attach ${ZELLIJ_SESSION}` };
  },
};

async function ensureZellijSession(signal?: AbortSignal): Promise<void> {
  const state = await zellijSessionState(signal);
  if (state === "active") {
    return;
  }
  if (state === "exited") {
    // Zellij serializes sessions and resurrects them on attach; a stale
    // resurrectable groundcrew session would replay dead agent tabs. Drop it
    // so we start clean. (delete-session only acts on non-active sessions.)
    try {
      await runWorkspaceCommand("zellij", ["delete-session", ZELLIJ_SESSION], signal);
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      debug(`zellij delete-session (stale) failed: ${errorMessage(error)}`);
    }
  }
  try {
    await runWorkspaceCommand(
      "zellij",
      ["--layout", stageSessionLayout(), "attach", "--create-background", ZELLIJ_SESSION],
      signal,
    );
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    // A racing creator may have won; tolerate that.
    if ((await zellijSessionState(signal)) === "active") {
      return;
    }
    throw error;
  }
}

/**
 * Whether the groundcrew session is live, resurrectable (serialized but not
 * running), or absent. Parses `list-sessions -n` (no ANSI); an exited session
 * is tagged `(EXITED - attach to resurrect)`.
 */
async function zellijSessionState(signal?: AbortSignal): Promise<"active" | "exited" | "absent"> {
  let output: string;
  try {
    output = await runWorkspaceCommand("zellij", ["list-sessions", "-n"], signal);
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    // `list-sessions` exits non-zero when there are no sessions at all.
    return "absent";
  }
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.split(/\s+/)[0] === ZELLIJ_SESSION) {
      return trimmed.includes("EXITED") ? "exited" : "active";
    }
  }
  return "absent";
}

function parseTabNames(output: string): Workspace[] {
  const items: Workspace[] = [];
  for (const line of output.split("\n")) {
    const name = line.trim();
    if (name.length === 0 || name === ZELLIJ_MAIN_TAB) {
      continue;
    }
    items.push({ name });
  }
  return items;
}

function parseTabId(output: string): number | undefined {
  // `new-tab` prints just the stable id; require the whole output to be that
  // integer so we never latch onto a stray number from an unexpected message.
  const trimmed = output.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

function isZellijMissingError(error: unknown): boolean {
  // Zellij phrases a missing/absent session several ways depending on whether
  // other sessions exist: "Session 'groundcrew' not found", "There is no
  // active session!", or "No active zellij sessions found". Scope the generic
  // "not found" to our session so unrelated zellij errors aren't swallowed.
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("no active session") ||
    message.includes("no active zellij sessions") ||
    (message.includes("not found") && message.includes(ZELLIJ_SESSION))
  );
}

// --- staged KDL layouts ------------------------------------------------------

let stagingDir: string | undefined;
function staging(): string {
  stagingDir ??= mkdtempSync(path.join(tmpdir(), "groundcrew-zellij-"));
  return stagingDir;
}

/** Escapes a value for embedding inside a KDL double-quoted string. */
function kdlString(value: string): string {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

/** Wraps a value in single quotes for a POSIX shell, escaping embedded quotes. */
function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Session layout: bars on every tab via the template, plus the `main` tab.
 * `main` tails the groundcrew log so attaching shows the live `crew run`
 * orchestrator output; it falls back to a shell if the command exits or no
 * log file is configured.
 */
function stageSessionLayout(): string {
  const file = path.join(staging(), "session.kdl");
  const logFile = getLogFile();
  // `tail -c +N` shows only the current run (the log is shared/append-mode);
  // N is the byte offset captured at process start, +1 to start just after it.
  const fromByte = getLogRunStartByte() + 1;
  const mainPane =
    logFile === undefined
      ? "        pane\n"
      : `        pane command="sh" {
            args "-c" "${kdlString(`tail -c +${fromByte} -F ${shSingleQuote(logFile)} || exec \${SHELL:-sh}`)}"
        }
`;
  writeFileSync(
    file,
    `layout {
    default_tab_template {
        pane size=1 borderless=true { plugin location="tab-bar"; }
        children
        pane size=1 borderless=true { plugin location="status-bar"; }
    }
    tab name="${ZELLIJ_MAIN_TAB}" {
${mainPane}    }
}
`,
  );
  return file;
}

/**
 * Per-ticket tab layout: bar plugins (a new tab does not inherit the session
 * template) wrapping the agent command. Written to an absolute path because
 * `new-tab --layout` resolves a file path, not an inline string.
 */
function stageTabLayout(ticket: string, command: string): string {
  const file = path.join(staging(), `tab-${ticket.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.kdl`);
  // Touch the exit marker once the agent exits on its own, so `list()` can
  // report the tab as exited. A groundcrew close kills the process first, so
  // the marker is never written in that case.
  try {
    mkdirSync(exitMarkerDir(), { recursive: true });
  } catch (error) {
    /* v8 ignore next @preserve -- best-effort: a failed marker dir only disables exit-state detection */
    debug(`zellij: could not create exit-marker dir: ${errorMessage(error)}`);
  }
  // An EXIT trap fires on any exit (including an explicit `exit` in the agent
  // command), unlike a trailing `; touch`. The marker path is sanitized to
  // [A-Za-z0-9_-] under tmpdir, so single-quoting it in the trap is safe.
  const wrapped = `trap ${shSingleQuote(`touch ${exitMarkerPath(ticket)}`)} EXIT; ${command}`;
  writeFileSync(
    file,
    `layout {
    pane size=1 borderless=true { plugin location="tab-bar"; }
    pane command="sh" {
        args "-c" "${kdlString(wrapped)}"
    }
    pane size=1 borderless=true { plugin location="status-bar"; }
}
`,
  );
  return file;
}

// --- ticket -> stable tab id (one file per ticket; see tabIdDir) -------------

function rememberTabId(name: string, id: number): void {
  try {
    mkdirSync(tabIdDir(), { recursive: true });
    writeFileSync(tabIdPath(name), String(id));
  } catch (error) {
    debug(`zellij: failed to persist tab id for ${name}: ${errorMessage(error)}`);
  }
}

function lookupTabId(name: string): number | undefined {
  try {
    return parseTabId(readFileSync(tabIdPath(name), "utf8"));
  } catch {
    return undefined;
  }
}

function forgetTabId(name: string): void {
  rmSync(tabIdPath(name), { force: true });
}
