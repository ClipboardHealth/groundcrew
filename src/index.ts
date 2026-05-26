export { run } from "./cli.ts";
export { cleanupWorkspace, type CleanupWorkspaceOptions } from "./commands/cleanupWorkspace.ts";
export { doctor } from "./commands/doctor.ts";
export {
  interruptWorkspace,
  type InterruptWorkspaceOptions,
} from "./commands/interruptWorkspace.ts";
export { orchestrate, type OrchestratorOptions } from "./commands/orchestrator.ts";
export { resumeWorkspace, type ResumeWorkspaceOptions } from "./commands/resumeWorkspace.ts";
export { setupWorkspace, type SetupWorkspaceOptions } from "./commands/setupWorkspace.ts";
export { status, type StatusOptions } from "./commands/status.ts";
export type { Config, ModelDefinition, ResolvedConfig, SourceConfig } from "./lib/config.ts";
export { loadConfig } from "./lib/config.ts";
export {
  readRunState,
  recordRunState,
  removeRunState,
  runStateDirectory,
  runStatePath,
  updateRunState,
  type RunLifecycleState,
  type RunState,
} from "./lib/runState.ts";
export {
  fetchBlockersForTicket,
  fetchInProgressIssueCount,
  fetchRawLinearIssue,
  fetchResolvedIssue,
  isIssueInProgress,
  isIssueTodo,
  isTerminalStateType,
  isTerminalStatusForBlocker,
  isTerminalStatusForIssue,
  resolveModelFor,
  resolveRepositoryFor,
  type ModelResolution,
  type RawLinearIssue,
  type RepositoryResolution,
} from "./lib/boardSource.ts";
export { getUsageByModel, type UsageByModel } from "./lib/usage.ts";
export { type Board, createBoard } from "./lib/board.ts";
export { buildSources, buildSourcesWith } from "./lib/buildSources.ts";
export type { AdapterContext, AdapterDefinition } from "./lib/adapterDefinition.ts";
export {
  adapterRegistry,
  type AdapterLoader,
  buildRegistry,
  buildSourceConfigSchema,
  listAdapterDirectories,
} from "./lib/adapters/registry.ts";
export {
  AmbiguousTicketError,
  type Blocker as CanonicalBlocker,
  type BoardState as CanonicalBoardState,
  type CanonicalStatus,
  type GroundcrewIssue as CanonicalGroundcrewIssue,
  type Issue as CanonicalIssue,
  isGroundcrewIssue as isCanonicalGroundcrewIssue,
  type TicketSource,
} from "./lib/ticketSource.ts";
// RepositoryResolutionError is exported via boardSource.ts above (single canonical location).
