/**
 * Shell: commander wiring, routing (repo add → Workspace; artifact add / done
 * → Run), rendering, and error-to-exit-code mapping; status is the read model
 * joining Run (reported) and Workspace (observed) (design §9.3).
 *
 * The runnable entry point is `main.ts` (bin/run.js imports it directly). This
 * `index.ts` is the module's import surface: it publishes the config zod schema
 * so the coordinator can generate the JSON Schema (design §7.2) without pulling
 * in the CLI's top-level execution.
 */
export const MODULE = "shell";

export { type Config, configSchema, PRESENTER_NAMES } from "./config/schema.js";
