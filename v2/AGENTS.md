# Groundcrew v2 agent instructions

You are working in `v2/`, the isolated workspace for the groundcrew v2 rewrite (design doc §2).
This tree has its own `package.json`, its own dependencies and lockfile, and its own build,
test, and architecture checks. It is **not** an npm workspace of the repo root; run all commands
from inside `v2/`.

## Ubiquitous language

Read [`CONTEXT.md`](./CONTEXT.md) before writing or reviewing code. It is the one glossary for
v2. v1 and v2 use several nouns with contradictory meanings (notably **Workspace**), so never
carry a v1 meaning into this tree. If you need a term that is not in `CONTEXT.md`, add it there
first.

## Module layout (design doc §9)

One bounded context, seven modules under `src/`:

- `acquisition/` — source bundle discovery and the versioned `list`/`get`/`update` protocol.
- `dispatch/` — the per-tick picker: poll, eligibility, claim, provision, terminal sweep.
- `run/` — the run record: state machine, reported layer, outcomes, the Writeback port.
- `workspace/` — worktrees, branches, the observed layer, task-identity resolution.
- `session/` — harness profiles, launch composition, pause/resume, the presenter contract.
- `sandbox/` — a pure `wrap(command, policy) → command` library; srt only, core-only.
- `shell/` — commander wiring, routing, rendering, error-to-exit-code mapping.

Plus `src/logging/` — the cross-cutting JSON-lines logging lib, deliberately **not** an eighth
module (design doc §10.2): every module except the pure `sandbox/` may import it, it imports
nothing, and its exported zod line schema is a published compatibility surface.

Shipped source bundles live in `task-sources/` — **outside `src/`, with no import path**. The
black-box acceptance suite lives in `e2e/`.

### Rules the architecture check enforces (`node --run architecture:check`)

- **A module's interface is its `index.ts`.** It is the only path other modules may import.
  Deep imports into another module's internal files are forbidden.
- **The dependency graph is an allowlist** (design doc §9.4): `shell → anything`;
  `dispatch → acquisition · workspace · session · run`; `run →` its own Writeback port only;
  `session → sandbox`; `acquisition → sandbox`; `workspace →` git only; `sandbox →` nothing in
  `src`. Nothing imports `shell`; only `shell` imports `dispatch`. An undeclared edge fails CI
  naming the seam it violated.
- **`e2e/` is black-box and must never import `src/`.** The suite spawns the built `crew`
  binary and observes the world. `src ↛ task-sources` and `task-sources ↛ src` in both
  directions.

## Coding rules

Follow the repo-wide rules in [`../.rules/common/`](../.rules/common/): TypeScript
(`typeScript.md`), testing (`testing.md`), and git workflow (`gitWorkflow.md`). Where the v2
design doc explicitly contradicts a rule, the design doc wins — most notably error handling: v2
uses **plain exceptions plus typed error classes** internally (native stack traces) and a
**result-shaped protocol** only at the public source boundary, not `ServiceResult`/neverthrow
(design doc §12.1).

## Workflow

- Red, green, refactor. The `e2e/` acceptance suite is v2's system-level TDD loop; unit tests
  colocate as `src/**/*.test.ts`.
- Validate with `node --run verify` (typecheck, build, architecture check, unit tests) from
  inside `v2/`.
- Commit locally with Conventional Commits, scope `v2` (e.g. `feat(v2): …`). Do not publish;
  `package.json` is `private` during construction.
