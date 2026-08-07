/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "module-entry-points-only",
      severity: "error",
      from: { path: String.raw`^src/(shell|core|source|workspace|run|presenter)/` },
      to: {
        path: String.raw`^src/(shell|core|source|workspace|run|presenter)/(?!index\.ts$)`,
        pathNot: String.raw`^src/$1/`,
      },
    },
    {
      name: "shell-only-imports-core",
      severity: "error",
      from: { path: String.raw`^src/shell/` },
      to: { path: String.raw`^src/(source|workspace|run|presenter)/` },
    },
    {
      name: "core-dependency-allowlist",
      severity: "error",
      from: { path: String.raw`^src/core/` },
      to: { path: String.raw`^src/(shell|presenter)/` },
    },
    {
      name: "run-only-imports-presenter",
      severity: "error",
      from: { path: String.raw`^src/run/` },
      to: { path: String.raw`^src/(shell|core|source|workspace)/` },
    },
    {
      name: "leaf-modules-do-not-cross",
      severity: "error",
      from: { path: String.raw`^src/(source|workspace|presenter)/` },
      to: { path: String.raw`^src/(shell|core|run)/` },
    },
    {
      name: "e2e-is-black-box",
      severity: "error",
      from: { path: String.raw`^e2e/` },
      to: { path: String.raw`^src/` },
    },
    {
      name: "v1-v2-import-ban",
      severity: "error",
      from: { path: String.raw`^(src|e2e|bin)/` },
      to: { path: String.raw`^\.\./` },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: ["dist", "node_modules", "test-output"] },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
