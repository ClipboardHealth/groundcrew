import { createVitestConfig } from "./vitest.shared.ts";

export default createVitestConfig({
  importMetaUrl: import.meta.url,
  name: "groundcrew",
  coverageExclude: ["src/main.ts", "src/testHelpers/**"],
});
