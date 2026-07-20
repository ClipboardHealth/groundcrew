/**
 * Section I — Surface & diagnostics (catalog §3.I, core lane).
 *
 * These scenarios are where the human-facing output *is* the behavior, so they
 * assert on `status` / `doctor` / `init` / `source doctor` stdout and exit
 * codes — loosely (key substrings, not golden files), per catalog §1.2. They
 * run in the hermetic core lane (no sandbox runner).
 */

import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentScriptsDirectory,
  branchExists,
  branchFor,
  configure,
  createRepo,
  installFixtureSource,
  installScriptedAgent,
  pollUntil,
  readLogLines,
  readRunRecord,
  run,
  runRecordExists,
  sessionFor,
  taskSlug,
  waitForSession,
  withScenario,
  writeAgentScript,
} from "../harness/index.js";
import type { AgentStep, LogLine, RunResult, Scenario } from "../harness/index.js";

const TASK_ID = "fixture:TASK-1";

/** A log line that names a run but not the task it belongs to — a schema violation for task-scoped events. */
function isRunScopedWithoutTask(line: LogLine): boolean {
  return line.runId !== undefined && line.taskId === undefined;
}

describe("I. Surface & diagnostics", () => {
  it("SURFACE-01: init produces a config that doctor passes and dispatch runs against", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      prepareInitHost({ scenario });

      const init = await runCrew({ scenario, args: ["init", "--yes"] });
      expect(init.exitCode).toBe(0);
      expect(fs.existsSync(configPath({ scenario }))).toBe(true);

      const doctor = await runCrew({ scenario, args: ["doctor"] });
      expect(doctor.exitCode).toBe(0);

      // DISPATCH-01 against the init-produced config, unmodified.
      const tick = await runCrew({ scenario, args: ["start"] });
      expect(tick.exitCode).toBe(0);
      await assertDispatched({ scenario, clonePath });
    });
  });

  describe("SURFACE-02: doctor catches broken hosts", () => {
    it("a) names a missing agent binary", async () => {
      await withScenario(async (scenario) => {
        const crew = configure({
          scenario,
          config: {
            agentProfiles: {
              scripted: { command: "groundcrew-missing-agent-xyz {{prompt}}" },
            },
          },
        });

        const doctor = await crew.doctor();
        expect(doctor.exitCode).toBe(1);
        expect(surfaceOf(doctor)).toMatch(/agent|groundcrew-missing-agent-xyz/i);
      });
    });

    it("b) names a failing source", async () => {
      await withScenario(async (scenario) => {
        const crew = configure({ scenario });
        crew.seedSource({ tasks: [], failList: true });

        const doctor = await crew.doctor();
        expect(doctor.exitCode).toBe(1);
        expect(surfaceOf(doctor)).toMatch(/source|fixture/i);
      });
    });

    it("c) names a missing base directory", async () => {
      await withScenario(async (scenario) => {
        const missing = path.join(scenario.root, "does-not-exist");
        const crew = configure({ scenario, config: { baseDirectory: missing } });

        const doctor = await crew.doctor();
        expect(doctor.exitCode).toBe(1);
        expect(surfaceOf(doctor)).toMatch(/base|director|does-not-exist/i);
      });
    });
  });

  it("SURFACE-03: status degrades gracefully when the source errors on list", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      writeAgentScript({ scenario, steps: deliveredSteps({ repo: "alpha" }) });
      crew.seedSource([{ id: "TASK-1", title: "do", agent: "scripted", repos: ["alpha"] }]);

      await crew.tick();
      await waitForSession({ scenario, name: crew.expect.sessionFor(TASK_ID) });
      await waitForComplete({ crew });
      // The delivered workspace lingers; it is the local truth status must keep showing.
      expect(await branchExists({ scenario, repoDirectory: clonePath, branch: crew.expect.branchFor(TASK_ID) })).toBe(true);

      crew.source.patch((store) => ({ ...store, failList: true }));

      const status = await crew.status();
      expect(status.exitCode).toBe(0);
      const surface = surfaceOf(status);
      expect(surface).toMatch(/task-1|alpha/i); // local truth still printed
      expect(surface).toMatch(/unavailable|error|fail|degrad/i); // queue marked unavailable with reason
    });
  });

  it("SURFACE-04: structured logs are parseable and task-scoped events carry taskId", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      writeAgentScript({ scenario, steps: deliveredSteps({ repo: "alpha" }) });
      crew.seedSource([{ id: "TASK-1", title: "do", agent: "scripted", repos: ["alpha"] }]);

      await crew.tick();
      await waitForSession({ scenario, name: crew.expect.sessionFor(TASK_ID) });
      await waitForComplete({ crew });

      // readLogLines validates every line against the log schema and throws on
      // the first violation — reaching here means all lines parsed and conform.
      const lines = readLogLines({ path: crew.paths.logFile });
      expect(lines.length).toBeGreaterThan(0);

      // Every run-scoped line must carry the taskId (no line with a runId lacks it).
      const runScopedWithoutTask = lines.filter(isRunScopedWithoutTask);
      expect(runScopedWithoutTask).toEqual([]);

      const taskIds = lines.map((line) => line.taskId);
      expect(taskIds).toContain(TASK_ID);
    });
  });

  it("SURFACE-05: init --yes is non-interactive and sufficient", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      prepareInitHost({ scenario });

      // Stdin closed (empty input): --yes must not prompt.
      const init = await runCrew({ scenario, args: ["init", "--yes"], input: "" });
      expect(init.exitCode).toBe(0);
      expect(fs.existsSync(configPath({ scenario }))).toBe(true);

      const doctor = await runCrew({ scenario, args: ["doctor"] });
      expect(doctor.exitCode).toBe(0);

      const tick = await runCrew({ scenario, args: ["start"] });
      expect(tick.exitCode).toBe(0);
      await assertDispatched({ scenario, clonePath });
    });
  });

  it("SURFACE-06: converts a v1 config, writing exactly what it announces, and tolerates v1 state", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      installScriptedAgent({ scenario });
      installAgentAs({ scenario, name: "claude" });
      installAgentAs({ scenario, name: "codex" });
      // The v1 `linear` source becomes a healthy, secret-free user bundle so the
      // converted config's linear source checks clean under doctor.
      const linear = installFixtureSource({ scenario, name: "linear" });
      linear.seed({ tasks: [{ id: "TASK-1", title: "do", agent: "claude", repos: ["alpha"] }] });
      // Live v1 run state sitting in the runs dir: v2 must ignore it, not crash (Bug 3).
      seedV1RunRecord({ scenario });
      fs.writeFileSync(v1ConfigPath({ scenario }), v1ConfigContents({ scenario }));
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      const init = await runCrew({ scenario, args: ["init", "--yes"] });
      expect(init.exitCode).toBe(0);
      expect(fs.existsSync(configPath({ scenario }))).toBe(true);

      const surface = surfaceOf(init);
      expect(surface).toMatch(/projectDir/); // renamed → workspace.baseDirectory
      expect(surface).toMatch(/shell/); // dropped shell source adapter
      expect(surface).toMatch(/safehouse|runner|local/i); // dropped runner/safehouse settings
      expect(surface).toMatch(/PUPPETEER_SKIP_CHROMIUM_DOWNLOAD/); // collected preLaunch export
      expect(surface).toMatch(/linear/); // kept, non-shell source

      // The written config carries what init announced — announcements cannot
      // diverge from the file (Bug 1: converter dropped these while announcing them).
      const config = readGeneratedConfig({ scenario });
      expect(config.sources[0]?.kind).toBe("linear");
      expect(config.sources[0]?.name).toBe("l");
      expect(config.sources.some((source) => source.kind === "shell")).toBe(false);
      expect(config.agents?.default).toBe("claude");
      expect(config.agents?.profiles?.["claude"]).toBeDefined();
      expect(config.agents?.profiles?.["codex"]).toBeDefined();
      expect(config.workspace.prepareWorktree).toBe("test ! -f package-lock.json || npm ci");
      expect(config.workspace.environment?.["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"]).toBe("true");

      // doctor passes despite the foreign v1 state file, and says it ignored it (Bug 3).
      const doctor = await runCrew({ scenario, args: ["doctor"] });
      expect(doctor.exitCode).toBe(0);
      expect(surfaceOf(doctor)).toMatch(/unrecognized state file|v1 state/i);
    });
  });

  it("SURFACE-06 (v1-config loud failure): a v2 command with only a v1 config fails with a migration pointer", async () => {
    await withScenario(async (scenario) => {
      fs.writeFileSync(v1ConfigPath({ scenario }), v1ConfigContents({ scenario }));

      const status = await runCrew({ scenario, args: ["status"] });
      expect(status.exitCode).not.toBe(0);
      expect(surfaceOf(status)).toMatch(/migrat|convert|v1|crew\.config\.ts|init/i);
    });
  });

  it("SURFACE-07: source doctor exercises a live round-trip and names a failing source", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "do", agent: "scripted", repos: ["alpha"] }]);

      const callsBefore = crew.source.calls().length;
      const healthy = await crew.sourceDoctor();
      expect(healthy.exitCode).toBe(0);
      // The probe hit the source over the process boundary (a new journal entry appeared).
      expect(crew.source.calls().length).toBeGreaterThan(callsBefore);

      crew.source.patch((store) => ({ ...store, failList: true }));

      const failing = await crew.sourceDoctor();
      expect(failing.exitCode).toBe(1);
      expect(surfaceOf(failing)).toMatch(/fixture/);
    });
  });
});

// --- Shared helpers --------------------------------------------------------

/** Combined stdout+stderr for loose human-output matching (catalog §1.2). */
function surfaceOf(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function configPath(input: { readonly scenario: Scenario }): string {
  return path.join(input.scenario.groundcrewConfigDirectory, "crew.config.jsonc");
}

function v1ConfigPath(input: { readonly scenario: Scenario }): string {
  return path.join(input.scenario.groundcrewConfigDirectory, "crew.config.ts");
}

/** A scripted-agent script that keeps the session alive so a DISPATCH-01 assertion holds. */
const HANG_SCRIPT: readonly AgentStep[] = [{ type: "hang" }];

/** A scripted-agent script that commits inside the worktree and reports delivered. */
function deliveredSteps(input: { readonly repo: string }): AgentStep[] {
  return [
    { type: "writeFile", path: `${input.repo}/agent.txt`, content: "work\n" },
    { type: "gitCommit", repo: input.repo, message: "agent work" },
    { type: "crew", args: ["done", "--outcome", "delivered"] },
  ];
}

/**
 * Prepares a host on which `crew init --yes` can produce a working config: the
 * fixture source pre-installed in the user dir (so init discovers it), the
 * scripted agent installed under the name `claude` (so init detects an agent
 * CLI on PATH), a seeded task, and a session-holding agent script.
 *
 * An init-produced config carries a `claude` *preset* profile, which does not
 * inject the scripted agent's GROUNDCREW_TEST_AGENT_SCRIPT. The
 * scripted-agent-as-claude finds its script because {@link runCrew} sets that
 * env on the `crew` process and agent sessions inherit the orchestrator's
 * ambient env (overlaid with the profile `environment` and GROUNDCREW_*
 * injections) — a contract commitment (contracts §7), so this is legitimate,
 * not a workaround.
 */
function prepareInitHost(input: { readonly scenario: Scenario }): void {
  const { scenario } = input;
  const source = installFixtureSource({ scenario, name: "fixture" });
  source.seed({ tasks: [{ id: "TASK-1", title: "do", agent: "claude", repos: ["alpha"] }] });
  installScriptedAgent({ scenario });
  installAgentAs({ scenario, name: "claude" });
  writeAgentScript({ scenario, steps: HANG_SCRIPT });
}

/** Copies the already-installed scripted agent to a second name on the scenario PATH. */
function installAgentAs(input: { readonly scenario: Scenario; readonly name: string }): void {
  const source = path.join(input.scenario.fakesBinDirectory, "scripted-agent");
  const destination = path.join(input.scenario.fakesBinDirectory, input.name);
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
}

/**
 * Runs the `crew` binary directly (bypassing `configure`, since init-based
 * scenarios have no harness-written config). Injects GROUNDCREW_TEST_AGENT_SCRIPT
 * so the scripted agent finds its script under an init-produced config; see the
 * gap noted on {@link prepareInitHost}.
 */
async function runCrew(input: {
  readonly scenario: Scenario;
  readonly args: readonly string[];
  readonly input?: string;
}): Promise<RunResult> {
  const [executable, ...base] = input.scenario.crewBinCommand;
  if (executable === undefined) {
    throw new Error("scenario.crewBinCommand is empty");
  }

  return await run({
    command: executable,
    args: [...base, ...input.args],
    cwd: input.scenario.baseDirectory,
    env: {
      ...input.scenario.env,
      GROUNDCREW_TEST_AGENT_SCRIPT: agentScriptsDirectory({ scenario: input.scenario }),
    },
    ...(input.input === undefined ? {} : { input: input.input }),
    timeoutMilliseconds: 60_000,
  });
}

/** Asserts the DISPATCH-01 provisioning surface for the standard single-repo task. */
async function assertDispatched(input: {
  readonly scenario: Scenario;
  readonly clonePath: string;
}): Promise<void> {
  const { scenario, clonePath } = input;
  const slug = taskSlug({ taskId: TASK_ID });

  await waitForSession({ scenario, name: sessionFor({ taskId: TASK_ID }) });

  const worktree = path.join(scenario.baseDirectory, ".groundcrew", "worktrees", slug, "alpha");
  expect(fs.existsSync(worktree)).toBe(true);
  expect(await branchExists({ scenario, repoDirectory: clonePath, branch: branchFor({ taskId: TASK_ID }) })).toBe(true);

  const record = readRunRecord({ path: path.join(scenario.stateRoot, "runs", `${slug}.json`) });
  expect(record.state).toBe("running");
}

/** Blocks until the run record reaches the terminal `complete` state. */
async function waitForComplete(input: {
  readonly crew: { readonly paths: { stateFor(taskId: string): string } };
}): Promise<void> {
  const statePath = input.crew.paths.stateFor(TASK_ID);
  await pollUntil({
    description: `run record at ${statePath} to reach complete`,
    condition: () =>
      runRecordExists({ path: statePath }) && readRunRecord({ path: statePath }).state === "complete",
  });
}

function v1ConfigContents(input: { readonly scenario: Scenario }): string {
  // The user's real dogfooding crew.config.ts (DEVOP): a global prepareWorktree
  // hook, agent definitions carrying pure-export preLaunch + preLaunchEnv, a
  // linear source alongside a shell source, projectDir + knownRepositories, and a
  // safehouse runner — every key the v2 converter must map, keep, or drop-with-why.
  return [
    'import type { Config } from "@clipboard-health/groundcrew";',
    "",
    "export default {",
    '  defaults: { hooks: { prepareWorktree: "test ! -f package-lock.json || npm ci" } },',
    "  workspace: {",
    `    projectDir: ${JSON.stringify(input.scenario.baseDirectory)},`,
    '    knownRepositories: ["alpha", /* …9 more repos */ "groundtruth"],',
    "  },",
    "  agents: {",
    '    default: "claude",',
    "    definitions: {",
    '      claude: { preLaunch: "export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true", preLaunchEnv: ["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"] },',
    '      codex: { preLaunch: "export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true", preLaunchEnv: ["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"] },',
    "    },",
    "  },",
    "  sources: [",
    '    { kind: "linear", name: "l" },',
    "    {",
    '      kind: "shell",',
    '      name: "jira",',
    '      sandboxWritePaths: ["~/plans"],',
    "      commands: {",
    '        listTasks: "~/.config/groundcrew/jira.sh list",',
    // Escaped so the v1 `${id}` template survives as a literal, not an interpolation.
    `        getTask: "~/.config/groundcrew/jira.sh get \${id}",`,
    "      },",
    "    },",
    "  ],",
    '  local: { runner: "auto", safehouse: { enable: ["agent-browser"] } },',
    "} satisfies Config;",
    "",
  ].join("\n");
}

/** The v2 config init writes, parsed (strip the leading JSONC comment line). */
interface GeneratedConfig {
  readonly workspace: {
    readonly baseDirectory: string;
    readonly worktreeDirectory?: string;
    readonly environment?: Record<string, string>;
    readonly prepareWorktree?: string;
  };
  readonly sources: ReadonlyArray<{ readonly kind: string; readonly name?: string }>;
  readonly agents?: {
    readonly default?: string;
    readonly profiles?: Record<string, unknown>;
  };
}

function readGeneratedConfig(input: { readonly scenario: Scenario }): GeneratedConfig {
  const raw = fs.readFileSync(configPath(input), "utf8");
  return JSON.parse(raw.slice(raw.indexOf("{"))) as GeneratedConfig;
}

/**
 * Seeds a live v1-shape run record into the scenario's runs dir. Its shape (task,
 * repository, branchName, …) is nothing like a v2 record, so v2 must classify it
 * foreign and ignore it — never zod-throw on it (Bug 3).
 */
function seedV1RunRecord(input: { readonly scenario: Scenario }): void {
  const runsDirectory = path.join(input.scenario.stateRoot, "runs");
  fs.mkdirSync(runsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(runsDirectory, "devop-1234.json"),
    JSON.stringify(
      {
        task: "DEVOP-1234",
        repository: "cbh-core",
        agent: "claude",
        worktreeDir: "/home/me/dev/.worktrees/devop-1234",
        branchName: "crew/devop-1234",
        workspaceName: "devop-1234",
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      undefined,
      2,
    ),
  );
}
