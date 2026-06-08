/**
 * zellij Workspace backend. Workspaces live as named tabs inside one
 * dedicated `groundcrew` zellij session; the tab name is the ticket id and
 * the first tab (`main`) is a placeholder that keeps the session alive. This
 * is a Linux/WSL alternative to tmux: zellij is a stateful multiplexer, so it
 * restores screen + terminal modes (mouse reporting, alt-screen) on every
 * attach, and enables the mouse by default. zellij can't paint status pills,
 * so `open` silently drops `spec.status`.
 *
 * Two zellij quirks shape this adapter:
 *   1. Tab actions that target the *active* tab (`close-tab`, `go-to-tab-name`)
 *      silently no-op on a detached session with no attached client. Only
 *      `close-tab-by-id` works headlessly — so `open` captures the stable id
 *      that `new-tab` prints and persists a ticket -> id map for `close`.
 *   2. `new-tab --layout` resolves a *file path* (not an inline string) and a
 *      per-tab layout does not inherit the session's tab-bar/status-bar, so we
 *      stage an absolute-path KDL file that includes the bar plugins itself.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type Adapter,
  isSignalAborted,
  runWorkspaceCommand,
  type Workspace,
} from "./workspaceAdapter.ts";
import { debug, errorMessage } from "./util.ts";

const ZELLIJ_SESSION = "groundcrew";
// The placeholder first tab; filtered out of `list()` like tmux's idle window.
const ZELLIJ_MAIN_TAB = "main";

// zellij sessions are per-user and die on reboot, matching tmpdir lifetime —
// so a tmpdir-backed ticket -> stable-tab-id map stays in sync with reality.
const TAB_ID_MAP_PATH = path.join(tmpdir(), "groundcrew-zellij-tabs.json");

export const zellijAdapter: Adapter = {
  async open(spec, signal) {
    await ensureZellijSession(signal);
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
    // zellij can't paint status pills; spec.status is silently dropped.
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
    return parseTabNames(output);
  },
  async close(name, signal) {
    const tabId = lookupTabId(name);
    if (tabId === undefined) {
      // Without the stable id we can't `close-tab-by-id`, and the active-tab
      // close paths no-op headlessly. Treat as already gone.
      debug(`zellij close: no tracked tab id for ${name}; treating as missing`);
      return { kind: "missing" };
    }
    try {
      await runWorkspaceCommand(
        "zellij",
        ["--session", ZELLIJ_SESSION, "action", "close-tab-by-id", String(tabId)],
        signal,
      );
      forgetTabId(name);
      return { kind: "closed" };
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      if (isZellijMissingError(error)) {
        forgetTabId(name);
        return { kind: "missing" };
      }
      throw error;
    }
  },
  accessHint(_name) {
    // zellij attaches at the session level; the user clicks the ticket's tab.
    return { kind: "attachCommand", command: `zellij attach ${ZELLIJ_SESSION}` };
  },
};

async function ensureZellijSession(signal?: AbortSignal): Promise<void> {
  if (await zellijSessionExists(signal)) {
    return;
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
    if (await zellijSessionExists(signal)) {
      return;
    }
    throw error;
  }
}

async function zellijSessionExists(signal?: AbortSignal): Promise<boolean> {
  try {
    const output = await runWorkspaceCommand("zellij", ["list-sessions", "-s"], signal);
    return output
      .split("\n")
      .map((line) => line.trim())
      .includes(ZELLIJ_SESSION);
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    // `list-sessions` exits non-zero when there are no sessions at all.
    return false;
  }
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
  const match = /\d+/.exec(output);
  return match ? Number(match[0]) : undefined;
}

function isZellijMissingError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("not found") ||
    message.includes("No active zellij sessions") ||
    message.includes("No more space")
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

/** Session layout: bars on every tab via the template, plus the `main` tab. */
function stageSessionLayout(): string {
  const file = path.join(staging(), "session.kdl");
  writeFileSync(
    file,
    `layout {
    default_tab_template {
        pane size=1 borderless=true { plugin location="tab-bar"; }
        children
        pane size=1 borderless=true { plugin location="status-bar"; }
    }
    tab name="${ZELLIJ_MAIN_TAB}"
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
  writeFileSync(
    file,
    `layout {
    pane size=1 borderless=true { plugin location="tab-bar"; }
    pane command="sh" {
        args "-c" "${kdlString(command)}"
    }
    pane size=1 borderless=true { plugin location="status-bar"; }
}
`,
  );
  return file;
}

// --- ticket -> stable tab id map (sidecar; see file header) ------------------

function readTabIdMap(): Record<string, number> {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- we wrote this file ourselves
    const parsed = JSON.parse(readFileSync(TAB_ID_MAP_PATH, "utf8")) as Record<string, number>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeTabIdMap(map: Record<string, number>): void {
  try {
    writeFileSync(TAB_ID_MAP_PATH, JSON.stringify(map));
  } catch (error) {
    debug(`zellij: failed to persist tab id map: ${errorMessage(error)}`);
  }
}

function rememberTabId(name: string, id: number): void {
  const map = readTabIdMap();
  map[name] = id;
  writeTabIdMap(map);
}

function lookupTabId(name: string): number | undefined {
  return readTabIdMap()[name];
}

function forgetTabId(name: string): void {
  const map = readTabIdMap();
  if (name in map) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- ticket-keyed map
    delete map[name];
    writeTabIdMap(map);
  }
}
