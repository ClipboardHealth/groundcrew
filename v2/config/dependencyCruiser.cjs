/**
 * Groundcrew v2 architecture rules (design doc §9.6).
 *
 * Run as `architecture:check` over `src e2e bin`. The section 9.4 dependency
 * graph is encoded as an allowlist: one `forbidden` rule per module names
 * exactly its ratified out-edges, so an undeclared import fails CI naming the
 * violated seam and the spec diagram and lint config cannot drift silently.
 *
 * Paths are relative to v2/ (the depcruise working directory).
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "No circular dependencies.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment:
        "No orphan modules. Module index.ts placeholders and the shell entry are exempt while the skeleton has no wiring.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          String.raw`(^|/)index\.ts$`,
          String.raw`^src/shell/main\.ts$`,
          String.raw`^bin/.*\.js$`,
          String.raw`\.test\.ts$`,
          String.raw`\.e2e\.test\.ts$`,
        ],
      },
      to: {},
    },

    // 1. Entry-point boundary (§9.6.1): a module's interface is its index.ts.
    //    Imports into src/<module>/ from outside that module must target the
    //    module's index.ts; deep imports into internal files are forbidden.
    {
      name: "module-entry-point-only",
      comment:
        "Cross-module imports must target the module's index.ts (spec §9.5/§9.6.1). Deep imports bypass the interface.",
      severity: "error",
      from: { path: String.raw`^src/([^/]+)/` },
      to: {
        path: String.raw`^src/([^/]+)/`,
        pathNot: [
          // Same module: intra-module imports of any file are free.
          String.raw`^src/$1/`,
          // Any module's index.ts is the permitted entry point.
          String.raw`^src/[^/]+/index\.ts$`,
        ],
      },
    },

    // 2. The §9.4 graph as an allowlist — one rule per module's out-edges.
    //    Shell → anything (thin composition root); it has no out-edge rule.
    {
      name: "dispatch-edges",
      comment:
        "Dispatch → Acquisition · Workspace · Session · Run only (spec §9.4).",
      severity: "error",
      from: { path: String.raw`^src/dispatch/` },
      to: {
        path: String.raw`^src/`,
        pathNot: String.raw`^src/(dispatch|acquisition|workspace|session|run)/`,
      },
    },
    {
      name: "run-edges",
      comment:
        "Run → nothing in src but its own Writeback port; never Acquisition, Session, Workspace, Dispatch, or Shell (spec §9.4a — Run's tests never touch discovery).",
      severity: "error",
      from: { path: String.raw`^src/run/` },
      to: {
        path: String.raw`^src/`,
        pathNot: String.raw`^src/run/`,
      },
    },
    {
      name: "session-edges",
      comment: "Session → Sandbox only (spec §9.4).",
      severity: "error",
      from: { path: String.raw`^src/session/` },
      to: {
        path: String.raw`^src/`,
        pathNot: String.raw`^src/(session|sandbox)/`,
      },
    },
    {
      name: "acquisition-edges",
      comment: "Acquisition → Sandbox only (spec §9.4).",
      severity: "error",
      from: { path: String.raw`^src/acquisition/` },
      to: {
        path: String.raw`^src/`,
        pathNot: String.raw`^src/(acquisition|sandbox)/`,
      },
    },
    {
      name: "workspace-edges",
      comment: "Workspace → nothing in src (git only) (spec §9.4).",
      severity: "error",
      from: { path: String.raw`^src/workspace/` },
      to: {
        path: String.raw`^src/`,
        pathNot: String.raw`^src/workspace/`,
      },
    },
    {
      name: "sandbox-edges",
      comment:
        "Sandbox → nothing in src (a pure library; core-only, not pluggable) (spec §9.4).",
      severity: "error",
      from: { path: String.raw`^src/sandbox/` },
      to: {
        path: String.raw`^src/`,
        pathNot: String.raw`^src/sandbox/`,
      },
    },
    {
      name: "no-import-of-shell",
      comment:
        "Nothing imports Shell — it is the composition root (spec §9.4c, acyclic; nothing calls upward).",
      severity: "error",
      from: { pathNot: String.raw`^src/shell/` },
      to: { path: String.raw`^src/shell/` },
    },
    {
      name: "no-import-of-dispatch",
      comment:
        "Only Shell imports Dispatch (spec §9.4c). Dispatch is a top-level driver, never a dependency of another module.",
      severity: "error",
      from: { pathNot: String.raw`^src/(shell|dispatch)/` },
      to: { path: String.raw`^src/dispatch/` },
    },

    // 3. Process-boundary rules (§9.6.3): shipped source bundles live outside
    //    src/ with no import path, and the e2e suite stays black-box.
    {
      name: "src-not-to-task-sources",
      comment:
        "src ↛ task-sources: shipped bundles cross the process boundary, never an import path (spec §9.5/§9.6.3).",
      severity: "error",
      from: { path: String.raw`^src/` },
      to: { path: String.raw`^task-sources/` },
    },
    {
      name: "task-sources-not-to-src",
      comment:
        "task-sources ↛ src: bundles are language-agnostic and never reach into core (spec §9.6.3).",
      severity: "error",
      from: { path: String.raw`^task-sources/` },
      to: { path: String.raw`^src/` },
    },
    {
      name: "e2e-not-to-src",
      comment:
        "e2e ↛ src: the acceptance suite is black-box — it spawns the built binary only (spec §9.6.3, catalog §1.1).",
      severity: "error",
      from: { path: String.raw`^e2e/` },
      to: { path: String.raw`^src/` },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      conditionNames: ["import", "require", "node", "default"],
      exportsFields: ["exports"],
      mainFields: ["main", "types", "typings"],
    },
    exclude: {
      path: ["dist", "coverage", "node_modules"],
    },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
