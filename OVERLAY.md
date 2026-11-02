## Repository Context

- **CLI behavior:** use red-green TDD through the local npm scripts in
  [`docs/development.md`](./docs/development.md). The globally installed `crew` runs the
  published version, not the checkout.
- **Validation:** run `node --run verify` from the repository root.
- **Coverage exclusions:** Vite/esbuild strips plain V8 hints during coverage remapping. For
  genuinely unreachable code, use `/* v8 ignore next @preserve */` for a statement or function
  and `/* v8 ignore else @preserve */` before an `if` whose else branch is unreachable.
