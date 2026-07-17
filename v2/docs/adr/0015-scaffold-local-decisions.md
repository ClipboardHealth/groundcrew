# 0015. Scaffold-local decisions: publish guard, workspace independence, Nx registration

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5983](https://linear.app/clipboardhealth/issue/DEVOP-5983) (v2 build)
- Design doc: §2 (repo strategy), §12.2 (handoff sequence, step 3)

## Context

Standing up the `v2/` workspace inside the same repo as v1 (ADR 0012) creates three construction
hazards that are not product decisions but must be recorded so the cutover can undo them.

## Decision

- **`"private": true` in `v2/package.json`.** v2 shares the package name
  `@clipboard-health/groundcrew` with root; the flag is a guard against an accidental publish
  during construction (no publish happens until the E2E suite is green, per ADR 0012). **The
  cutover removes this flag** when `v2/` is flattened to the repo root.
- **v2 is not an npm workspace of the root.** The repo root has no `workspaces` field and gains
  none. `v2/` keeps its own `package.json`, dependency set, and lockfile, installed from inside
  `v2/`. This keeps v1 and v2 dependency graphs, versions, and tooling fully independent and
  keeps root tooling (syncpack, knip) from reaching into v2.
- **v2 is registered as a separate Nx project `groundcrew-v2`** via `v2/project.json`
  (`root: "v2"`). Because both `package.json` files would otherwise infer the name `groundcrew`,
  the explicit `project.json` is required to avoid a duplicate-name collision, and it makes Nx's
  file map attribute `v2/**` files to `groundcrew-v2` — which is **not** in
  `nx.json` `release.projects` (`["groundcrew"]`). A commit touching only `v2/**` therefore does
  not enter `groundcrew`'s release version calculation (design doc §2 release-automation wrinkle).

## Consequences

- Root `node --run verify` treats `v2/` as out of scope for the lint/format/spell/markdown/cpd
  tools via minimal, surgical ignores; v2 quality is carried by v2's own `node --run verify`
  (typecheck, build, architecture check, unit tests) plus the e2e suite.
- At cutover: drop `private`, delete `v2/project.json`, and flatten the tree so the single
  `groundcrew` project again owns the whole repo.
