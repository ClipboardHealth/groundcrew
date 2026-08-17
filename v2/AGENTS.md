# Groundcrew v2

This directory is an independent, private Node.js workspace. Read [`CONTEXT.md`](./CONTEXT.md)
before changing domain behavior. Run commands from `v2/`; validate every code change with
`node --run verify`.

Use red-green TDD through the built `crew` executable for behavior visible to operators and
source authors. Unit-test only pure logic, concurrency, and hard-to-reach failures. The e2e
suite may spawn `bin/run.js` and inspect filesystem, Git, protocol, and presenter effects; it
must not import `src/`.

The six modules are `shell`, `core`, `source`, `workspace`, `run`, and `presenter`. Another
module imports a module only through its `index.ts`. Keep the dependency graph
`shell -> core`, `core -> source|workspace|run`, and `run -> presenter`; leaf modules depend
only on the operating-system services they wrap. The architecture check enforces these seams.

This implementation follows the DEVOP-6369 contract. Groundcrew v1 and historical v2 design
documents are not implementation inputs. The package is run from the built checkout and is
never published.
