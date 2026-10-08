# Sidebar regression tests

Swift Testing suites that drive `../groundcrew.swift` through cmux's own custom-sidebar interpreter
(`SwiftViewInterpreter`) with synthetic workspace snapshots, so stage derivation, row layout, and
the context-menu actions can be checked without launching cmux itself.

- `GroundcrewSidebarStageTests.swift` — stage rule order, section grouping, the stale-poller
  caption and its feature-off degradation, and the `crew stage` context-menu actions.
- `GroundcrewSidebarRowLayoutTests.swift` — the compact two-line row (title + agent-icon strip,
  ticket/PR pills), confirming the per-row stage badge text, directory line, and native status line
  are all gone from the row itself (that information lives in the section header instead).
- `GroundcrewSidebarStaleAgentTests.swift` — per-agent icon color/opacity for idle, executing,
  `needs_input`, and abandoned (2h+ silent) agent states.
- `GroundcrewSidebarPrLinkTests.swift` — `prLink`/`prLinkTarget` against the shipped default
  (`"github"`).
- `GroundcrewSidebarRenderBenchTests.swift` — median parse+eval cost over repeated
  `SwiftViewInterpreter.evaluate(source:state:)` calls, the same call cmux makes on every 1s
  `TimelineView` tick. A render costing more than ~1s backs up 9-13 piled renders and blanks the
  sidebar, so this is a real budget, not a nice-to-have.

These are not part of this repository's `npm run verify` — they need a cmux checkout and its Swift
toolchain, neither of which this repository depends on.

## Run

```bash
cp contrib/cmux/tests/*.swift \
  ~/Documents/work/cmux/Packages/macOS/CmuxSwiftRender/Tests/CmuxSwiftRenderTests/
cd ~/Documents/work/cmux/Packages/macOS/CmuxSwiftRender
GROUNDCREW_SIDEBAR_PATH=/path/to/groundcrew/contrib/cmux/groundcrew.swift \
  swift test --filter GroundcrewSidebar
```

All five suites skip (not fail) when `GROUNDCREW_SIDEBAR_PATH` is unset. Point it at
`contrib/cmux/groundcrew.swift` to test this repository's shipped file, or at an installed copy
under `~/.config/cmux/sidebars/` to test a local install.

Remove the copied files from the cmux checkout afterwards (`rm Tests/CmuxSwiftRenderTests/Groundcrew*.swift`)
so it stays clean for upstream syncs — they are test fixtures copied in for this one run, not part of
the cmux checkout.

## Render-cost bench

`GroundcrewSidebarRenderBenchTests` takes its own env var, independent of the suites above:

```bash
GROUNDCREW_BENCH_SPECS="label:/path/to/groundcrew.swift:heartbeat" \
  swift test --filter GroundcrewSidebarRenderBenchTests
```

`GROUNDCREW_BENCH_SPECS` is a comma-separated list of `label:path[:contract]` entries (`contract` is
`"heartbeat"` for this file's `crew_poller_heartbeat`-driven freshness contract; omit it or pass
`"epoch"` only when benchmarking an older epoch-suffixed `crew_stage` format). Compare multiple
files in one run — e.g. a candidate change against the currently-installed file — by passing several
comma-separated entries. The test prints one `BENCH label=… median_ms=…` line per entry rather than
asserting a threshold, since the budget is "doesn't blank the sidebar in practice" rather than a
fixed number; treat a median much above the file you're replacing as a regression worth
investigating before installing.
