/**
 * Public surface of the groundcrew e2e harness.
 *
 * Scenarios import from here only. The harness is black-box: it spawns the
 * built `crew` binary and observes the world through git, tmux, state files,
 * logs, and the fixture source's call journal (catalog §1). It never imports
 * `src/` — dependency-cruiser enforces this.
 */

export { configure } from "./bindings.js";
export type {
  AgentProfileFixture,
  Bindings,
  CleanupOptions,
  CommandOptions,
  ConfigFixture,
  HarnessExpectations,
  HarnessPaths,
  OrchestratorHandle,
  SourceFixture,
} from "./bindings.js";

export { run } from "./exec.js";
export type { RunOptions, RunResult } from "./exec.js";

export {
  makeFailingShim,
  makeRecordingShim,
  readCallLog,
  readGhCalls,
} from "./fakeBin.js";
export type { RecordedCall } from "./fakeBin.js";

export { installFixtureSource } from "./fixtureSource.js";
export type { FixtureSource, FixtureStore, SourceCall } from "./fixtureSource.js";

export {
  branchExists,
  commitSubjects,
  createBareRepo,
  createClone,
  createRepo,
  currentBranch,
  isDirty,
  worktreeList,
  writeAndCommit,
} from "./gitFixtures.js";
export type { WorktreeEntry } from "./gitFixtures.js";

export {
  branchFor,
  canonicalTaskId,
  DEFAULT_BRANCH_PREFIX,
  sessionFor,
  taskSlug,
} from "./identity.js";

export { logLineSchema, logLevelSchema, logModuleSchema } from "./logSchema.js";
export type { LogLine } from "./logSchema.js";

export { delay, pollForValue, pollUntil } from "./poll.js";
export type { PollOptions } from "./poll.js";

export { createScenario, withScenario } from "./scenario.js";
export type { Scenario } from "./scenario.js";

export {
  agentScriptsDirectory,
  heartbeatPath,
  installScriptedAgent,
  readLaunchRecord,
  readResumeRecords,
  waitForHeartbeat,
  waitForLaunchRecord,
  waitForResume,
  writeAgentScript,
} from "./scriptedAgent.js";
export type { AgentStep, LaunchRecord, ResumeRecord } from "./scriptedAgent.js";

export {
  artifactSchema,
  dispatchVerdictsSchema,
  getDataSchema,
  isoUtcTimestamp,
  listDataSchema,
  protocolResultSchema,
  runOutcomeSchema,
  runRecordSchema,
  runStateSchema,
  skipReasonSchema,
  taskSchema,
  updateDataSchema,
  workspaceMarkerSchema,
  writebackEventSchema,
} from "./schemas.js";
export type {
  Artifact,
  DispatchVerdicts,
  RunOutcome,
  RunRecord,
  SkipReason,
  Task,
  WorkspaceMarker,
  WritebackEvent,
} from "./schemas.js";

export {
  readDispatchVerdicts,
  readLogLines,
  readRunRecord,
  readWorkspaceMarker,
  runRecordExists,
} from "./stateObservation.js";

export {
  listSessionNames,
  sessionExists,
  waitForSession,
  waitForSessionGone,
} from "./tmuxObservation.js";

export {
  encodeProbeSpec,
  installSandboxProbeAgent,
  installSandboxProbeSource,
  PROBE_AGENT_SPEC_ENV,
  PROBE_SOURCE_SPEC_ENV,
  probeOutcomeSchema,
  readProbeOutcome,
  sourceScratchDirectory,
  startLoopbackServer,
  waitForProbeOutcome,
} from "./sandboxLane.js";
export type {
  LoopbackServer,
  ProbeAction,
  ProbeExecAction,
  ProbeHttpAction,
  ProbeOutcome,
  ProbeReadAction,
  ProbeWriteAction,
} from "./sandboxLane.js";
