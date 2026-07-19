/**
 * Acquisition: source bundle discovery, the versioned `list`/`get`/`update`
 * process protocol, and source sandboxing. Owns the source-protocol contract
 * seam (spec §9.3). This `index.ts` is the module's only import surface.
 *
 * The public verbs:
 *   - {@link discoverSources} scans the package + user bundle dirs into a
 *     classified {@link DiscoveredSource} list (ok / unsupported / invalid);
 *   - {@link openSource} turns a supported bundle into a live {@link SourceHandle}
 *     driving the protocol behind the result-shaped process boundary;
 *   - {@link probeSource} is the doctor round-trip.
 */
export const MODULE = "acquisition";

export {
  discoverSources,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./discover.js";
export type {
  DiscoveredSource,
  DiscoveredSourceInvalid,
  DiscoveredSourceOk,
  DiscoveredSourceUnsupported,
  SourceCapabilities,
  SourceOrigin,
} from "./discover.js";

export {
  DEFAULT_SOURCE_TIMEOUT_MILLISECONDS,
  missingSecretError,
  openSource,
  SOURCE_SCRATCH_ENV,
} from "./openSource.js";
export type {
  OpenSourceInput,
  SourceConfig,
  SourceHandle,
  WrapCommand,
} from "./openSource.js";

export { probeSource } from "./probe.js";
export type { ProbeResult } from "./probe.js";

export { MissingSecretError, SourceProtocolError } from "./errors.js";
export type { SourceFailureKind } from "./errors.js";

export { createSecretsResolver, parseDotenv } from "./secrets.js";
export type { SecretsResolver } from "./secrets.js";

export { parseManifest, sourceManifestSchema } from "./manifest.js";
export type { ParseManifestResult, SourceManifest } from "./manifest.js";

export {
  artifactSchema,
  getDataSchema,
  listDataSchema,
  protocolEnvelopeSchema,
  RUN_OUTCOMES,
  runOutcomeSchema,
  SOURCE_COMMANDS,
  taskSchema,
  updateResultSchema,
  writebackEventSchema,
} from "./protocol.js";
export type {
  Artifact,
  ProtocolEnvelope,
  RunOutcome,
  SourceCommand,
  Task,
  UpdateResult,
  WritebackEvent,
} from "./protocol.js";
