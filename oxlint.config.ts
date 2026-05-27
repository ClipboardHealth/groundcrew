import { base, createOxlintConfig, vitest } from "@clipboard-health/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig(
  createOxlintConfig({
    localConfig: {
      options: {
        reportUnusedDisableDirectives: "error",
        typeAware: true,
        typeCheck: true,
      },
      overrides: [
        {
          files: ["**/bin/**/*.js", "**/bin/**/*.cjs"],
          rules: {
            "typescript/no-unsafe-argument": "off",
            "typescript/no-unsafe-assignment": "off",
            "typescript/strict-boolean-expressions": "off",
          },
        },
        {
          // ticketDoctor.ts is a ~1500-line orchestrating command; the
          // matching unit-test file is comprehensive (~2200 lines covering
          // every probe, verdict path, and section, including non-Linear
          // source path tests added in the source-agnostic doctor refactor).
          // Splitting by describe block would create cross-file coupling on
          // shared makeConfig / makeStubDependencies helpers without
          // improving readability. Bump the cap for this one file.
          files: ["**/ticketDoctor.test.ts"],
          rules: {
            "max-lines": ["error", 2500],
          },
        },
      ],
    },
    presets: [base, vitest],
  }),
);
