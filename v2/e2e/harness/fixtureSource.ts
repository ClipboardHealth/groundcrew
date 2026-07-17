/**
 * Installs the committed fixture-source bundle into a scenario and exposes its
 * task store and call journal (catalog §1.4 "Fixture source").
 *
 * The bundle is copied into the scenario's user source directory
 * (`$XDG_CONFIG_HOME/groundcrew/task-sources/<name>/`, contracts §2) so `crew`
 * discovers it like any user bundle. Its behavior is driven entirely by a JSON
 * task store the harness owns; every invocation of a source command appends to
 * `calls.jsonl` next to the store — the writeback assertion point. A read-only
 * variant installs a manifest with no `update` command (COMPLETE-05/PLUGIN-05).
 */

import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { taskSchema } from "./schemas.js";
import type { Scenario } from "./scenario.js";

/** The JSON task store backing the fixture source; every field is a configurable knob. */
export const fixtureStoreSchema = z
  .object({
    /** Source-local tasks, in the protocol task shape (contracts §4.3). */
    tasks: z.array(taskSchema),
    /** Task ids whose `claimed` writeback the source answers with `rejected` (FLOW-03). */
    rejectClaims: z.array(z.string()).optional(),
    /** When true, `list` returns a protocol failure (SURFACE-03). */
    failList: z.boolean().optional(),
    /** When true, `get` returns a protocol failure. */
    failGet: z.boolean().optional(),
    /** Ids the source considers completed; dropped from `list` unless recurring. */
    completedTaskIds: z.array(z.string()).optional(),
    /** Completed ids that `list` keeps returning (DISPATCH-09 recurrence). */
    recurringTaskIds: z.array(z.string()).optional(),
    /** Completion outcomes recorded by `update` (FLOW-05/COMPLETE-07 source-side truth). */
    completions: z
      .record(
        z.string(),
        z.object({
          outcome: z.string(),
          artifacts: z.array(z.unknown()).optional(),
          message: z.string().optional(),
        }),
      )
      .optional(),
  })
  .loose();

export type FixtureStore = z.infer<typeof fixtureStoreSchema>;

/** One recorded source-command invocation from `calls.jsonl`. */
export const sourceCallSchema = z.object({
  command: z.enum(["list", "get", "update"]),
  args: z.array(z.string()),
  stdin: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
});

export type SourceCall = z.infer<typeof sourceCallSchema>;

const manifestSchema = z.record(z.string(), z.unknown());

export interface FixtureSource {
  readonly name: string;
  /** Installed bundle directory under the scenario's user source path. */
  readonly bundleDirectory: string;
  /** The JSON task store path; goes into config as the source's FIXTURE_STORE env. */
  readonly storePath: string;
  /** The call journal path, next to the store. */
  readonly callsPath: string;
  /** Overwrites the store (the `seedSource` mechanism). */
  seed(store: FixtureStore): void;
  /** Read-modify-write the store between ticks (blocker done, mark terminal, …). */
  patch(mutate: (store: FixtureStore) => FixtureStore): void;
  /** Current store contents. */
  readStore(): FixtureStore;
  /** Every recorded call, in order. */
  calls(): SourceCall[];
  /** Recorded calls filtered to `update`. */
  updateCalls(): SourceCall[];
}

const DEFAULT_SOURCE_NAME = "fixture";

/** Installs the fixture-source bundle into `scenario` and returns its handle. */
export function installFixtureSource(input: {
  readonly scenario: Scenario;
  readonly name?: string;
  readonly readOnly?: boolean;
}): FixtureSource {
  const { scenario } = input;
  const name = input.name ?? DEFAULT_SOURCE_NAME;
  const readOnly = input.readOnly ?? false;

  const templateDirectory = path.resolve(fileDirectory(), "..", "fixtures", "fixture-source");
  const bundleDirectory = path.join(scenario.groundcrewConfigDirectory, "task-sources", name);
  fs.mkdirSync(bundleDirectory, { recursive: true });

  for (const script of ["list", "get", "update"]) {
    const destination = path.join(bundleDirectory, script);
    fs.copyFileSync(path.join(templateDirectory, script), destination);
    fs.chmodSync(destination, 0o755);
  }

  const manifestTemplate = readOnly ? "source.readonly.json" : "source.json";
  const manifestJson: unknown = JSON.parse(
    fs.readFileSync(path.join(templateDirectory, manifestTemplate), "utf8"),
  );
  const manifest = manifestSchema.parse(manifestJson);
  manifest["name"] = name;
  fs.writeFileSync(
    path.join(bundleDirectory, "source.json"),
    JSON.stringify(manifest, undefined, 2) + "\n",
  );

  const storeDirectory = path.join(scenario.root, `fixture-store-${name}`);
  const storePath = path.join(storeDirectory, "store.json");
  const callsPath = path.join(storeDirectory, "calls.jsonl");
  fs.mkdirSync(storeDirectory, { recursive: true });

  const handle: FixtureSource = {
    name,
    bundleDirectory,
    storePath,
    callsPath,
    seed(store: FixtureStore): void {
      fs.writeFileSync(storePath, JSON.stringify(store, undefined, 2) + "\n");
    },
    patch(mutate: (store: FixtureStore) => FixtureStore): void {
      handle.seed(mutate(handle.readStore()));
    },
    readStore(): FixtureStore {
      if (!fs.existsSync(storePath)) {
        throw new Error(`fixture store not found at ${storePath}; call seed() first`);
      }

      const parsed: unknown = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return fixtureStoreSchema.parse(parsed);
    },
    calls(): SourceCall[] {
      if (!fs.existsSync(callsPath)) {
        return [];
      }

      return fs
        .readFileSync(callsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const parsed: unknown = JSON.parse(line);
          return sourceCallSchema.parse(parsed);
        });
    },
    updateCalls(): SourceCall[] {
      return handle.calls().filter((call) => call.command === "update");
    },
  };

  handle.seed({ tasks: [] });
  return handle;
}

function fileDirectory(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}
