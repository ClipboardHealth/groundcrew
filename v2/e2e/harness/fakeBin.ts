/**
 * Helpers around the fakes bin directory (catalog §1.4).
 *
 * The committed `gh` fake is installed into every scenario by the scenario
 * factory; this module reads back its recorded calls and provides two shim
 * generators: {@link makeFailingShim} to shadow a real binary with one that
 * exits nonzero (e.g. a failing `tmux` for CRASH-04's probe-unavailable
 * variant), and {@link makeRecordingShim} to shadow one with a call recorder.
 */

import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Scenario } from "./scenario.js";

export const recordedCallSchema = z.object({
  argv: z.array(z.string()),
  timestamp: z.string(),
});

export type RecordedCall = z.infer<typeof recordedCallSchema>;

/**
 * Reads the calls the fake `gh` recorded for this scenario. Returns `[]` when
 * `gh` was never invoked (the file is absent) — the FLOW-06 "zero calls" case.
 */
export function readGhCalls(input: { readonly scenario: Scenario }): RecordedCall[] {
  return readCallLog(input.scenario.fakeGhLogPath);
}

/**
 * Writes an executable shim named `name` into `directory` (defaults to the
 * scenario's fakes bin, so it shadows the real binary on PATH). The shim exits
 * with `exitCode` (default 1) after printing `message` to stderr.
 */
export function makeFailingShim(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly directory?: string;
  readonly exitCode?: number;
  readonly message?: string;
}): string {
  const { scenario, name } = input;
  const directory = input.directory ?? scenario.fakesBinDirectory;
  const exitCode = input.exitCode ?? 1;
  const message = input.message ?? `${name} is unavailable (e2e failing shim)`;

  const body = [
    "#!/usr/bin/env node",
    '"use strict";',
    `process.stderr.write(${JSON.stringify(`${message}\n`)});`,
    `process.exit(${String(exitCode)});`,
    "",
  ].join("\n");

  return writeExecutable({ directory, name, body });
}

/**
 * Writes an executable shim named `name` that records every invocation
 * (argv + timestamp) to `logPath` and exits 0. Used to observe in-session
 * `crew` invocations without spawning the real binary.
 */
export function makeRecordingShim(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly logPath: string;
  readonly directory?: string;
}): string {
  const { scenario, name, logPath } = input;
  const directory = input.directory ?? scenario.fakesBinDirectory;

  const body = [
    "#!/usr/bin/env node",
    '"use strict";',
    'const fs = require("node:fs");',
    `const logPath = ${JSON.stringify(logPath)};`,
    "fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2), timestamp: new Date().toISOString() }) + \"\\n\");",
    "process.exit(0);",
    "",
  ].join("\n");

  return writeExecutable({ directory, name, body });
}

/** Reads a JSONL call log written by the fake `gh` or a recording shim. */
export function readCallLog(logPath: string): RecordedCall[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return recordedCallSchema.parse(parsed);
    });
}

function writeExecutable(input: {
  readonly directory: string;
  readonly name: string;
  readonly body: string;
}): string {
  const { directory, name, body } = input;
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name);
  fs.writeFileSync(target, body);
  fs.chmodSync(target, 0o755);
  return target;
}
