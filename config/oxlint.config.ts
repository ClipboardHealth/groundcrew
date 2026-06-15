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
      // `crew.config.example.ts` is a template the `crew init` command writes
      // into user projects. It imports from `@clipboard-health/groundcrew` so
      // it resolves there, but locally that path lives only in
      // `tsconfig.base.json`'s `paths` mapping — and the file isn't included
      // in any leaf tsconfig project, so oxlint's typeAware pass can't apply
      // the mapping. The file isn't internal source, so exclude it from lint.
      ignorePatterns: ["crew.config.example.ts"],
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
        {
          // setupWorkspace.test.ts covers launch composition across cmux,
          // tmux, safehouse, srt, sdx, rollback, and CLI source-resolution
          // paths. Keep those shared mocks together; splitting the file causes
          // duplicate module mocks to race under Vitest's parallel runner.
          files: ["**/setupWorkspace.test.ts"],
          rules: {
            "max-lines": ["error", 2200],
          },
        },
      ],
    },
    presets: [base, vitest],
  }),
);
