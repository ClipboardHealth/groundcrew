import { createVitestConfig } from "./config/vitestShared.ts";

export default createVitestConfig({
  importMetaUrl: import.meta.url,
  name: "groundcrew",
  coverageExclude: ["src/main.ts", "src/agentWorkspaceTrustCli.ts", "src/testHelpers/**"],
});
