/**
 * Section H — Sandbox posture (catalog §3.H, sandbox lane §1.6).
 *
 * This lane runs *real* srt: on macOS it wraps agents and sources with
 * `sandbox-exec`, and asserts denial behavior that cannot be faked honestly.
 * The whole describe is opt-in and platform-gated — it runs only on macOS with
 * `GROUNDCREW_E2E_SANDBOX=1`. Linux/bubblewrap is intentionally untested here:
 * this machine is macOS, and v1's posture keeps its own unit-level coverage.
 *
 * Each scenario observes outcomes through marker files a probe writes: the
 * permitted action records `{ ok: true }`, the denied one records
 * `{ ok: false }` with the errno — so both are observed as files, never as a
 * crash. Probes get their spec through an environment variable, so it survives
 * into the sandbox without any filesystem grant; markers always land in a
 * sandbox-writable place (the agent workspace, or the source scratch dir).
 */

import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  branchFor,
  commitSubjects,
  configure,
  createRepo,
  encodeProbeSpec,
  installSandboxProbeAgent,
  installSandboxProbeSource,
  PROBE_AGENT_SPEC_ENV,
  PROBE_SOURCE_SPEC_ENV,
  sourceScratchDirectory,
  startLoopbackServer,
  taskSlug,
  waitForProbeOutcome,
  withScenario,
} from "../harness/index.js";
import type { ProbeAction, Scenario } from "../harness/index.js";

// oxlint-disable-next-line node/no-process-env -- the sandbox lane is opt-in via a host env var
const sandboxOptIn = process.env["GROUNDCREW_E2E_SANDBOX"] === "1";
const sandboxLaneEnabled = process.platform === "darwin" && sandboxOptIn;

const TASK_ID = "fixture:TASK-1";

/** Deterministic workspace root for a task (contracts §2 default layout). */
function workspaceDirectory(input: { readonly scenario: Scenario; readonly taskId: string }): string {
  return path.join(
    input.scenario.baseDirectory,
    ".groundcrew",
    "worktrees",
    taskSlug({ taskId: input.taskId }),
  );
}

describe.runIf(sandboxLaneEnabled)("H. Sandbox posture", () => {
  it("SANDBOX-01: contains the agent to its workspace by default", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const workspace = workspaceDirectory({ scenario, taskId: TASK_ID });
      const insideTarget = path.join(workspace, "inside.txt");
      const insideMarker = path.join(workspace, ".probe", "inside.json");
      const outsideTarget = path.join(scenario.root, `sandbox-outside-${scenario.id}.txt`);
      const outsideMarker = path.join(workspace, ".probe", "outside.json");

      const actions: ProbeAction[] = [
        { kind: "write", path: insideTarget, marker: insideMarker },
        { kind: "write", path: outsideTarget, marker: outsideMarker },
      ];

      const crew = configure({
        scenario,
        config: {
          agentProfiles: {
            scripted: {
              command: "sandbox-probe",
              environment: { [PROBE_AGENT_SPEC_ENV]: encodeProbeSpec({ actions }) },
            },
          },
        },
      });
      installSandboxProbeAgent({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted", repos: ["alpha"] }]);

      await crew.tick();

      const inside = await waitForProbeOutcome({ marker: insideMarker });
      const outside = await waitForProbeOutcome({ marker: outsideMarker });

      expect(inside.ok).toBe(true);
      expect(fs.existsSync(insideTarget)).toBe(true);

      expect(outside.ok).toBe(false);
      expect(fs.existsSync(outsideTarget)).toBe(false);
    }, { sandboxLane: true });
  });

  // srt (the ratified, only runner) filters remote egress by host and treats
  // loopback as a single allowLocalBinding capability — it has no port
  // dimension. The catalog's two-ports-one-config formulation is therefore not
  // expressible; the same assertion (allowlisted succeeds, non-allowlisted
  // fails) runs as two dispatches under two configs.
  it("SANDBOX-02: allowlists the agent's network egress", async () => {
    const fixture = await startLoopbackServer();
    try {
      await withScenario(async (scenario) => {
        await createRepo({ scenario, name: "alpha" });

        const workspace = workspaceDirectory({ scenario, taskId: TASK_ID });
        const allowMarker = path.join(workspace, ".probe", "allow.json");

        const crew = configure({
          scenario,
          config: {
            sandbox: { network: [fixture.hostPort] },
            agentProfiles: {
              scripted: {
                command: "sandbox-probe",
                environment: {
                  [PROBE_AGENT_SPEC_ENV]: encodeProbeSpec({
                    actions: [{ kind: "httpGet", url: fixture.url, marker: allowMarker }],
                  }),
                },
              },
            },
          },
        });
        installSandboxProbeAgent({ scenario });
        crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted", repos: ["alpha"] }]);

        await crew.tick();

        const allow = await waitForProbeOutcome({ marker: allowMarker });
        expect(allow.ok).toBe(true);
        expect(allow.detail).toBe("200");
      }, { sandboxLane: true });

      await withScenario(async (scenario) => {
        await createRepo({ scenario, name: "alpha" });

        const workspace = workspaceDirectory({ scenario, taskId: TASK_ID });
        const denyMarker = path.join(workspace, ".probe", "deny.json");

        const crew = configure({
          scenario,
          config: {
            sandbox: { network: [] },
            agentProfiles: {
              scripted: {
                command: "sandbox-probe",
                environment: {
                  [PROBE_AGENT_SPEC_ENV]: encodeProbeSpec({
                    actions: [{ kind: "httpGet", url: fixture.url, marker: denyMarker }],
                  }),
                },
              },
            },
          },
        });
        installSandboxProbeAgent({ scenario });
        crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted", repos: ["alpha"] }]);

        await crew.tick();

        const deny = await waitForProbeOutcome({ marker: denyMarker });
        expect(deny.ok).toBe(false);
      }, { sandboxLane: true });
    } finally {
      await fixture.close();
    }
  });

  it("SANDBOX-03: sandboxes sources by default", async () => {
    const loopback = await startLoopbackServer();
    try {
      await withScenario(async (scenario) => {
        // HARNESS GAP: the source discovers its scratch dir only because the
        // harness hands it absolute marker paths under the canonical location
        // (contracts §2: <stateRoot>/source-scratch/<name>/). Core must grant
        // that exact directory read-write and create it before invoking a
        // sandboxed `list`; the harness pre-creates it so the marker writes have
        // somewhere to land under RED.
        const scratch = sourceScratchDirectory({ scenario, sourceName: "fixture" });
        const scratchWriteMarker = path.join(scratch, "scratch-write.json");
        const outWriteMarker = path.join(scratch, "out-write.json");
        const installReadMarker = path.join(scratch, "install-read.json");
        const egressMarker = path.join(scratch, "egress.json");

        const outOfScopeTarget = path.join(scenario.root, `source-out-${scenario.id}.txt`);

        const crew = configure({
          scenario,
          config: { sources: [{ name: "fixture", kind: "fixture" }] },
        });

        // The probe spec references the install-dir read target, known only
        // once the bundle exists, so it is patched in after installation.
        installSandboxProbeSource({ bundleDirectory: crew.source.bundleDirectory, name: "fixture" });
        rewriteSourceProbeSpec({
          scenario,
          sourceName: "fixture",
          actions: [
            { kind: "write", path: path.join(scratch, "scratch.txt"), marker: scratchWriteMarker },
            { kind: "write", path: outOfScopeTarget, marker: outWriteMarker },
            { kind: "read", path: path.join(crew.source.bundleDirectory, "source.json"), marker: installReadMarker },
            { kind: "httpGet", url: loopback.url, marker: egressMarker },
          ],
        });

        crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted" }]);
        await crew.tick();

        const scratchWrite = await waitForProbeOutcome({ marker: scratchWriteMarker });
        const outWrite = await waitForProbeOutcome({ marker: outWriteMarker });
        const installRead = await waitForProbeOutcome({ marker: installReadMarker });
        const egress = await waitForProbeOutcome({ marker: egressMarker });

        expect(scratchWrite.ok).toBe(true);
        expect(installRead.ok).toBe(true);
        expect(outWrite.ok).toBe(false);
        expect(fs.existsSync(outOfScopeTarget)).toBe(false);
        expect(egress.ok).toBe(false);
      }, { sandboxLane: true });
    } finally {
      await loopback.close();
    }
  });

  it("SANDBOX-04: sandbox:false opt-out runs unsandboxed and is flagged loudly", async () => {
    const loopback = await startLoopbackServer();
    try {
      await withScenario(async (scenario) => {
        const scratch = sourceScratchDirectory({ scenario, sourceName: "fixture" });
        const outWriteMarker = path.join(scratch, "out-write.json");
        const outOfScopeTarget = path.join(scenario.root, `source-out-${scenario.id}.txt`);

        const crew = configure({
          scenario,
          config: {
            sources: [{ name: "fixture", kind: "fixture", sandbox: false }],
          },
        });
        installSandboxProbeSource({ bundleDirectory: crew.source.bundleDirectory, name: "fixture" });
        rewriteSourceProbeSpec({
          scenario,
          sourceName: "fixture",
          actions: [{ kind: "write", path: outOfScopeTarget, marker: outWriteMarker }],
        });

        crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted" }]);
        await crew.tick();

        const outWrite = await waitForProbeOutcome({ marker: outWriteMarker });
        // With the sandbox opted out, the out-of-scope write succeeds.
        expect(outWrite.ok).toBe(true);
        expect(fs.existsSync(outOfScopeTarget)).toBe(true);

        const status = await crew.status();
        const doctor = await crew.doctor();
        const surface = `${status.stdout}\n${status.stderr}\n${doctor.stdout}\n${doctor.stderr}`;
        expect(surface).toMatch(/sandbox/i);
        expect(surface).toMatch(/fixture/);
        expect(surface).toMatch(/false|disabled|off|opt/i);
      }, { sandboxLane: true });
    } finally {
      await loopback.close();
    }
  });

  // Regression for the dropped real-agent grants: the initial v2 port never
  // granted the parent clone's `.git`, so a sandboxed agent could not commit —
  // and the existing probes never caught it because they only wrote inside the
  // workspace. Here the agent commits *inside its worktree* and we assert the
  // object landed in the parent clone's shared object store.
  it("SANDBOX-05: a sandboxed agent commits in its worktree and the object lands in the parent clone", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      const workspace = workspaceDirectory({ scenario, taskId: TASK_ID });
      const worktree = path.join(workspace, "alpha");
      const commitMarker = path.join(workspace, ".probe", "commit.json");
      const subject = `sandbox commit ${scenario.id}`;

      const actions: ProbeAction[] = [
        {
          kind: "exec",
          command: "git",
          args: ["commit", "--allow-empty", "-m", subject],
          cwd: worktree,
          marker: commitMarker,
        },
      ];

      const crew = configure({
        scenario,
        config: {
          agentProfiles: {
            scripted: {
              command: "sandbox-probe",
              environment: { [PROBE_AGENT_SPEC_ENV]: encodeProbeSpec({ actions }) },
            },
          },
        },
      });
      installSandboxProbeAgent({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted", repos: ["alpha"] }]);

      await crew.tick();

      // The commit succeeded *inside the sandbox* — the parent clone's `.git`
      // (the shared object store) was granted write.
      const commit = await waitForProbeOutcome({ marker: commitMarker });
      expect(commit.ok).toBe(true);

      // And it physically landed in the parent clone: the worktree branch now
      // carries the commit, read back from the clone itself (outside any sandbox).
      const subjects = await commitSubjects({
        scenario,
        repoDirectory: clonePath,
        ref: branchFor({ taskId: TASK_ID }),
      });
      expect(subjects[0]).toBe(subject);
    }, { sandboxLane: true });
  });

  // Regression for the whole-`.git` write grant: contracts §9 keeps the clone's
  // `.git` writable so commits land, but the executable surfaces inside it —
  // `hooks/` (a planted `post-checkout` runs on the user's next host git op) and
  // `config` (`core.hooksPath`) — must stay unwritable. Here the agent commits
  // (permitted) but its attempts to plant a hook and rewrite the config are both
  // denied, proving the carve-out coexists with a working commit.
  it("SANDBOX-06: denies writing .git/hooks and .git/config while commits still succeed", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      const workspace = workspaceDirectory({ scenario, taskId: TASK_ID });
      const worktree = path.join(workspace, "alpha");
      const gitDir = path.join(clonePath, ".git");

      const hookTarget = path.join(gitDir, "hooks", "post-checkout");
      const configTarget = path.join(gitDir, "config");
      const hookMarker = path.join(workspace, ".probe", "hook-write.json");
      const configMarker = path.join(workspace, ".probe", "config-write.json");
      const commitMarker = path.join(workspace, ".probe", "commit.json");

      const actions: ProbeAction[] = [
        { kind: "write", path: hookTarget, marker: hookMarker },
        { kind: "write", path: configTarget, marker: configMarker },
        {
          kind: "exec",
          command: "git",
          args: ["commit", "--allow-empty", "-m", `carve-out commit ${scenario.id}`],
          cwd: worktree,
          marker: commitMarker,
        },
      ];

      const crew = configure({
        scenario,
        config: {
          agentProfiles: {
            scripted: {
              command: "sandbox-probe",
              environment: { [PROBE_AGENT_SPEC_ENV]: encodeProbeSpec({ actions }) },
            },
          },
        },
      });
      installSandboxProbeAgent({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "probe", agent: "scripted", repos: ["alpha"] }]);

      await crew.tick();

      const hookWrite = await waitForProbeOutcome({ marker: hookMarker });
      const configWrite = await waitForProbeOutcome({ marker: configMarker });
      const commit = await waitForProbeOutcome({ marker: commitMarker });

      // The host-RCE persistence surfaces are denied even though .git is writable…
      expect(hookWrite.ok).toBe(false);
      expect(configWrite.ok).toBe(false);
      // …and the planted hook never made it to disk.
      expect(fs.existsSync(hookTarget)).toBe(false);
      // …while a normal commit inside the worktree still succeeds.
      expect(commit.ok).toBe(true);
    }, { sandboxLane: true });
  });
});

/**
 * Rewrites the source's probe spec after `installSandboxProbeSource` has run.
 * `configure` seeds the source `environment` (and therefore the spec) at config
 * write time, before the bundle directory — and thus the install-dir read
 * target — is known; this patches the spec into the on-disk config in place.
 */
function rewriteSourceProbeSpec(input: {
  readonly scenario: Scenario;
  readonly sourceName: string;
  readonly actions: readonly ProbeAction[];
}): void {
  const configPath = path.join(
    input.scenario.groundcrewConfigDirectory,
    "crew.config.jsonc",
  );
  const raw = fs.readFileSync(configPath, "utf8");
  const withoutHeader = raw.replace(/^\/\/[^\n]*\n/u, "");
  const parsed = JSON.parse(withoutHeader) as {
    sources: Array<{ name?: string; environment?: Record<string, string> }>;
  };

  const entry = parsed.sources.find((source) => source.name === input.sourceName);
  if (entry === undefined) {
    throw new Error(`no source named ${input.sourceName} in the generated config`);
  }

  entry.environment = {
    ...entry.environment,
    [PROBE_SOURCE_SPEC_ENV]: encodeProbeSpec({ actions: input.actions }),
  };
  fs.writeFileSync(configPath, JSON.stringify(parsed, undefined, 2) + "\n");
}
