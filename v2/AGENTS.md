# Groundcrew v2

This directory is an independent, private Node.js workspace. Use [`CONTEXT.md`](./CONTEXT.md)
and the live `v2/` code as implementation sources; the root v1 implementation and historical v2
design documents are context only. Run commands from `v2/`; validate every code change with
`node --run verify`. This package runs from the built checkout and is not published.

Use red-green TDD through the built `crew` executable for behavior visible to operators and
source authors. The e2e suite may spawn `bin/run.js` and inspect filesystem, Git, protocol, and
presenter effects; it must not import `src/`.

The six modules are `shell`, `core`, `source`, `workspace`, `run`, and `presenter`. Another
module imports a module only through its `index.ts`. Keep the dependency graph
`shell -> core`, `core -> source|workspace|run`, and `run -> presenter`; leaf modules depend
only on the operating-system services they wrap. The architecture check enforces these seams.
