/**
 * Sandbox-lane harness (catalog §1.6, §3.H). These helpers back the sandbox
 * posture scenarios, which run real srt (`sandbox-exec` on macOS) and assert
 * denial behavior that cannot be faked honestly. They are opt-in and platform-
 * gated by the scenarios themselves; nothing here runs in the core lane.
 *
 * Two stand-ins live here:
 *  - a loopback HTTP fixture server (ephemeral port, always 200) that egress
 *    probes hit — an allowlisted target succeeds, a non-allowlisted one is
 *    denied by the sandbox, not by a closed port;
 *  - probe executables (a sandboxed *agent* and a sandboxed *source* `list`)
 *    that execute a declarative spec and record each action's outcome into a
 *    marker file, so both the permitted and the denied path are observed as
 *    files rather than as a process crash.
 *
 * The probe spec is handed to the probe process through an environment variable
 * (agent profile / source `environment`), never a file, so it survives into the
 * sandbox without needing a filesystem grant. Every marker path the harness
 * supplies must live in a sandbox-writable location (the agent's workspace, or
 * the source's scratch dir); only an action's target may point out of scope.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import path from "node:path";

import { z } from "zod";

import { pollForValue } from "./poll.js";
import type { Scenario } from "./scenario.js";

// --- Loopback egress fixture ----------------------------------------------

export interface LoopbackServer {
  /** The ephemeral TCP port the server bound to. */
  readonly port: number;
  /** Loopback host the server bound to (`127.0.0.1`). */
  readonly host: string;
  /** `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** `<host>:<port>`, the form an egress allowlist entry uses. */
  readonly hostPort: string;
  /** Stops the server. Idempotent-safe to await once. */
  close(): Promise<void>;
}

/**
 * Starts a loopback HTTP server on an ephemeral port that answers every request
 * with `200 ok`. Egress probes hit this so a denial is unambiguously the
 * sandbox's doing (the server is up), not a refused connection.
 */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not bind to a TCP port");
  }

  const { port } = address;
  const host = "127.0.0.1";

  return {
    port,
    host,
    url: `http://${host}:${String(port)}/`,
    hostPort: `${host}:${String(port)}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

// --- Probe spec and outcomes ----------------------------------------------

export interface ProbeWriteAction {
  readonly kind: "write";
  /** Absolute target to write; may point out of the sandbox and be denied. */
  readonly path: string;
  /** Absolute marker path (must be sandbox-writable) where the outcome lands. */
  readonly marker: string;
}

export interface ProbeReadAction {
  readonly kind: "read";
  readonly path: string;
  readonly marker: string;
}

export interface ProbeHttpAction {
  readonly kind: "httpGet";
  readonly url: string;
  readonly marker: string;
  readonly timeoutMilliseconds?: number;
}

export interface ProbeExecAction {
  readonly kind: "exec";
  /** Executable to run (resolved on the sandboxed PATH). */
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory for the spawn. */
  readonly cwd: string;
  /** Marker records `{ ok: exit===0, detail: stdout|stderr|exit }`. */
  readonly marker: string;
}

export type ProbeAction = ProbeWriteAction | ProbeReadAction | ProbeHttpAction | ProbeExecAction;

/** Source manifest as an open key/value map (the harness only rewrites `name`). */
const manifestSchema = z.record(z.string(), z.unknown());

/** Recorded outcome of a single probe action, read back from its marker file. */
export const probeOutcomeSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export type ProbeOutcome = z.infer<typeof probeOutcomeSchema>;

/** Serializes a probe spec for the `GROUNDCREW_SANDBOX_PROBE_JSON` env var. */
export function encodeProbeSpec(input: { readonly actions: readonly ProbeAction[] }): string {
  return JSON.stringify({ actions: input.actions });
}

/** The env var name the sandbox probe *agent* reads its spec from. */
export const PROBE_AGENT_SPEC_ENV = "GROUNDCREW_SANDBOX_PROBE_JSON";

/** The env var name the sandbox probe *source* reads its spec from. */
export const PROBE_SOURCE_SPEC_ENV = "GROUNDCREW_SOURCE_PROBE_JSON";

// --- Probe agent -----------------------------------------------------------

/**
 * Installs the `sandbox-probe` agent executable onto the scenario PATH. Point an
 * agent profile's `command` at `sandbox-probe` and carry the spec in the
 * profile `environment` under {@link PROBE_AGENT_SPEC_ENV}.
 */
export function installSandboxProbeAgent(input: { readonly scenario: Scenario }): string {
  const source = path.resolve(fileDirectory(), "..", "fixtures", "sandbox-probe", "sandbox-probe");
  const destination = path.join(input.scenario.fakesBinDirectory, "sandbox-probe");
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
  return destination;
}

// --- Probe source ----------------------------------------------------------

/**
 * Overwrites an already-installed source bundle's scripts and manifest with the
 * sandbox source-posture variant (its `list` runs the probe spec). Call after
 * `configure` has installed the bundle; pass the source's `bundleDirectory` and
 * its `name` so the manifest keeps the right name.
 */
export function installSandboxProbeSource(input: {
  readonly bundleDirectory: string;
  readonly name: string;
}): void {
  const template = path.resolve(fileDirectory(), "..", "fixtures", "sandbox-probe-source");

  for (const script of ["list", "get", "update"]) {
    const destination = path.join(input.bundleDirectory, script);
    fs.copyFileSync(path.join(template, script), destination);
    fs.chmodSync(destination, 0o755);
  }

  const manifest = manifestSchema.parse(
    JSON.parse(fs.readFileSync(path.join(template, "source.json"), "utf8")),
  );
  manifest["name"] = input.name;
  fs.writeFileSync(
    path.join(input.bundleDirectory, "source.json"),
    JSON.stringify(manifest, undefined, 2) + "\n",
  );
}

/**
 * The per-source scratch dir (contracts §2): `<stateRoot>/source-scratch/<name>/`.
 * The sandbox grants this to the source read-write. The harness pre-creates it
 * so probe markers have somewhere to land and computes marker paths under it.
 */
export function sourceScratchDirectory(input: {
  readonly scenario: Scenario;
  readonly sourceName: string;
}): string {
  const directory = path.join(input.scenario.stateRoot, "source-scratch", input.sourceName);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

// --- Marker observation ----------------------------------------------------

/** Reads a probe marker if present; `undefined` while the action has not run. */
export function readProbeOutcome(input: { readonly marker: string }): ProbeOutcome | undefined {
  if (!fs.existsSync(input.marker)) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(input.marker, "utf8"));
  return probeOutcomeSchema.parse(parsed);
}

/** Blocks until a probe marker exists, returning the recorded outcome. */
export async function waitForProbeOutcome(input: {
  readonly marker: string;
  readonly timeoutMilliseconds?: number;
}): Promise<ProbeOutcome> {
  return await pollForValue({
    description: `sandbox probe marker at ${input.marker}`,
    ...(input.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: input.timeoutMilliseconds }),
    probe: () => readProbeOutcome({ marker: input.marker }),
  });
}

function fileDirectory(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}
