/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      comment: "No circular dependencies",
      from: {},
      name: "no-circular",
      severity: "error",
      to: { circular: true },
    },
    {
      comment: "No orphan modules (files not reachable from entry points)",
      from: {
        orphan: true,
        pathNot: [
          String.raw`/bin/.*\.js$`,
          String.raw`\.test\.ts$`,
          String.raw`\.spec\.ts$`,
          String.raw`configExample\.ts$`,
          String.raw`vitest\.config\.ts$`,
        ],
      },
      name: "no-orphans",
      severity: "error",
      to: {},
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
      path: ["dist", "out-tsc", "test-output", "coverage"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/(@[^/]+/[^/]+|[^/]+)" },
      text: { highlightFocused: true },
    },
    tsConfig: { fileName: "tsconfig.lint.json" },
    tsPreCompilationDeps: false,
  },
};
