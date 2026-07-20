/**
 * Per-scenario environment factory: the hermetic sandbox every e2e test runs
 * inside (catalog §1.4 "Host env").
 *
 * Each scenario owns a fresh tmpdir that backs HOME, XDG_CONFIG_HOME, and
 * XDG_STATE_HOME, a base directory for git clones, an isolated tmux socket, and
 * a fakes bin directory prepended to PATH. PATH is otherwise hermetic — only
 * the directories holding node, git, tmux, and the system utilities they need —
 * so nothing installed on the host leaks in. Cleanup kills the scenario's tmux
 * server and removes the tmpdir, and runs even when a test throws.
 */

// cspell:ignore nosystem

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { run } from "./exec.js";

export interface Scenario {
  /** Unique per scenario; also the tmux socket name (contracts §7). */
  readonly id: string;
  /** The scenario tmpdir; everything below lives under it. */
  readonly root: string;
  readonly home: string;
  readonly configHome: string;
  readonly stateHome: string;
  /** `$XDG_CONFIG_HOME/groundcrew`. */
  readonly groundcrewConfigDirectory: string;
  /** `$XDG_STATE_HOME/groundcrew`. */
  readonly stateRoot: string;
  /** Where working clones live; the config's `workspace.baseDirectory`. */
  readonly baseDirectory: string;
  /** Where bare `file://` remotes live. */
  readonly remotesDirectory: string;
  /** Prepended to PATH; holds the fake `gh` and any shims. */
  readonly fakesBinDirectory: string;
  /** Where the fake `gh` records its invocations (FLOW-06 assertion point). */
  readonly fakeGhLogPath: string;
  readonly tmuxSocket: string;
  /** Hermetic environment for every spawn in this scenario. */
  readonly env: Readonly<Record<string, string>>;
  /** The `crew` binary invocation as `[executable, ...args]`. */
  readonly crewBinCommand: readonly string[];
  /** Kills the scenario tmux server and removes the tmpdir. Idempotent. */
  dispose(): Promise<void>;
}

export interface CreateScenarioOptions {
  /**
   * Selects the lane's sandbox posture via the crew env (contracts §7).
   * Default `false` (core lane) → `GROUNDCREW_SANDBOX="off"` is set, the
   * hermetic kill-switch that keeps the core lane out of real srt. `true`
   * (sandbox lane) → the variable is omitted so core sandboxes for real.
   *
   * This is per-scenario, never keyed off a process-global: a sandbox-lane run
   * shares the vitest process with core-lane scenarios, which must keep their
   * kill-switch.
   */
  readonly sandboxLane?: boolean;
}

/** Creates a scenario environment. Caller is responsible for {@link Scenario.dispose}. */
export function createScenario(options: CreateScenarioOptions = {}): Scenario {
  const id = `gc-${crypto.randomBytes(4).toString("hex")}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));

  const home = path.join(root, "home");
  const configHome = path.join(home, ".config");
  const stateHome = path.join(home, ".local", "state");
  const groundcrewConfigDirectory = path.join(configHome, "groundcrew");
  const stateRoot = path.join(stateHome, "groundcrew");
  const baseDirectory = path.join(root, "base");
  const remotesDirectory = path.join(root, "remotes");
  const fakesBinDirectory = path.join(root, "fakes-bin");
  const fakeGhLogPath = path.join(root, "fake-gh-calls.jsonl");

  for (const directory of [
    home,
    configHome,
    stateHome,
    groundcrewConfigDirectory,
    stateRoot,
    baseDirectory,
    remotesDirectory,
    fakesBinDirectory,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  installFakeBinaries(fakesBinDirectory);
  writeGlobalGitConfig(home);

  const pathValue = buildHermeticPath(fakesBinDirectory);
  const crewBinCommand = resolveCrewBinCommand();

  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    PATH: pathValue,
    TERM: "xterm",
    LANG: "C",
    GROUNDCREW_TMUX_SOCKET: id,
    GROUNDCREW_E2E_CREW_BIN: crewBinCommand.join(" "),
    FAKE_GH_LOG: fakeGhLogPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Core lane pins the kill-switch; the sandbox lane omits it (contracts §7).
    ...(options.sandboxLane === true ? {} : { GROUNDCREW_SANDBOX: "off" }),
  };

  let disposed = false;

  return {
    id,
    root,
    home,
    configHome,
    stateHome,
    groundcrewConfigDirectory,
    stateRoot,
    baseDirectory,
    remotesDirectory,
    fakesBinDirectory,
    fakeGhLogPath,
    tmuxSocket: id,
    env,
    crewBinCommand,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }

      disposed = true;
      await run({
        command: "tmux",
        args: ["-L", id, "kill-server"],
        env,
        timeoutMilliseconds: 10_000,
      });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Runs `body` with a fresh scenario and guarantees cleanup, even on throw.
 * The preferred entry point for scenarios and self-tests.
 */
export async function withScenario<T>(
  body: (scenario: Scenario) => Promise<T>,
  options?: CreateScenarioOptions,
): Promise<T> {
  const scenario = createScenario(options);
  try {
    return await body(scenario);
  } finally {
    await scenario.dispose();
  }
}

function writeGlobalGitConfig(home: string): void {
  const contents = [
    "[user]",
    "\tname = Groundcrew E2E",
    "\temail = e2e@groundcrew.test",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[safe]",
    "\tdirectory = *",
    "[protocol \"file\"]",
    "\tallow = always",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(home, ".gitconfig"), contents);
}

function installFakeBinaries(fakesBinDirectory: string): void {
  const fakeSourceDirectory = path.resolve(
    fileDirectory(),
    "..",
    "fixtures",
    "fake-bin",
  );
  for (const name of fs.readdirSync(fakeSourceDirectory)) {
    const destination = path.join(fakesBinDirectory, name);
    fs.copyFileSync(path.join(fakeSourceDirectory, name), destination);
    fs.chmodSync(destination, 0o755);
  }
}

function buildHermeticPath(fakesBinDirectory: string): string {
  const directories = [
    fakesBinDirectory,
    path.dirname(process.execPath),
    resolveBinaryDirectory("git"),
    resolveBinaryDirectory("tmux"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const directory of directories) {
    if (!seen.has(directory)) {
      seen.add(directory);
      deduped.push(directory);
    }
  }

  return deduped.join(path.delimiter);
}

function resolveCrewBinCommand(): readonly string[] {
  // oxlint-disable-next-line node/no-process-env -- the harness must read the host's crew-bin override
  const override = process.env["GROUNDCREW_E2E_CREW_BIN"];
  if (override !== undefined && override.trim() !== "") {
    return override.trim().split(/\s+/u);
  }

  const runJs = path.resolve(fileDirectory(), "..", "..", "bin", "run.js");
  return [process.execPath, runJs];
}

/**
 * Returns the directory of the first `name` found on the host PATH. Throws a
 * descriptive error if the binary is not reachable — the scenario cannot be
 * hermetic without it.
 */
function resolveBinaryDirectory(name: string): string {
  // oxlint-disable-next-line node/no-process-env -- the hermetic PATH is built from the host's real PATH
  const pathValue = process.env["PATH"] ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === "") {
      continue;
    }

    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return directory;
    } catch {
      // Not here; keep looking.
    }
  }

  throw new Error(
    `Cannot build a hermetic PATH: required binary '${name}' was not found on the host PATH`,
  );
}

function fileDirectory(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}
