/**
 * Run: the run record — state machine, the reported layer (artifact add / done
 * intake), outcomes, and the writeback point. Owns the Writeback port, defined
 * here in src/run/ and consumer-owned (spec §9.3).
 */
export const MODULE = "run";

export {
  RUN_RECORD_VERSION,
  RUN_STATES,
  RUN_OUTCOMES,
  runRecordSchema,
  runsDirectory,
  runRecordPath,
  readRunRecord,
  writeRunRecord,
  runRecordExists,
  deleteRunRecord,
  listRunRecords,
} from "./runRecord.js";
export type { Artifact, RunEvent, RunRecord, RunState, RunOutcome } from "./runRecord.js";

export {
  Run,
  createRun,
  loadRun,
  runExists,
  deleteRun,
  listRuns,
  generateRunId,
} from "./run.js";
export type { CreateRunInput, LoadRunInput, CompleteRunInput } from "./run.js";

export { InvalidTransitionError, RunNotFoundError } from "./errors.js";

export { noopWritebackPort } from "./writeback.js";
export type { WritebackPort, WritebackCompletion } from "./writeback.js";
