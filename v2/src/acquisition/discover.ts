/**
 * Source bundle discovery (design §6, contracts §4.1). Scans the package and
 * user bundle directories, parses each `source.json`, and classifies it. Nothing
 * is ever silently dropped:
 *   - a valid, supported bundle → an `ok` entry with its capabilities;
 *   - a parseable bundle whose `protocolVersion` core does not support → an
 *     `unsupported` entry naming the version and the supported set;
 *   - an unparseable/invalid manifest → an `invalid` entry carrying a warning.
 * A user bundle shadows a package bundle of the same name (the override is
 * representable so `source list` can show it — PLUGIN-02).
 */
import * as fs from "node:fs";
import path from "node:path";

import { parseManifest } from "./manifest.js";
import type { SourceManifest } from "./manifest.js";

/** Protocol generations core understands (design §6: v2.0 ships `{1}`). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/** Where a bundle was found. Provenance tiers collapse to these two (design §6). */
export type SourceOrigin = "package" | "user";

/** Which protocol commands a bundle exposes; `list` is always present when `ok`. */
export interface SourceCapabilities {
  readonly list: true;
  readonly get: boolean;
  readonly update: boolean;
}

interface DiscoveredSourceCommon {
  readonly name: string;
  readonly origin: SourceOrigin;
  readonly bundleDirectory: string;
  /** Set when this entry hides a same-named bundle from the other origin. */
  readonly shadows?: SourceOrigin;
}

export interface DiscoveredSourceOk extends DiscoveredSourceCommon {
  readonly status: "ok";
  readonly manifest: SourceManifest;
  readonly protocolVersion: number;
  readonly capabilities: SourceCapabilities;
  /** No `update` command ⇒ read-only source; writeback no-ops (design §6). */
  readonly readOnly: boolean;
}

export interface DiscoveredSourceUnsupported extends DiscoveredSourceCommon {
  readonly status: "unsupported";
  readonly protocolVersion: number;
  readonly supportedVersions: readonly number[];
  readonly message: string;
}

export interface DiscoveredSourceInvalid extends DiscoveredSourceCommon {
  readonly status: "invalid";
  readonly warning: string;
}

export type DiscoveredSource =
  | DiscoveredSourceOk
  | DiscoveredSourceUnsupported
  | DiscoveredSourceInvalid;

/**
 * Discovers every bundle under the two directories. Returns one entry per
 * distinct source name, user origin winning collisions, sorted by name for a
 * stable `source list`.
 */
export function discoverSources(input: {
  readonly packageBundlesDirectory: string;
  readonly userBundlesDirectory: string;
}): DiscoveredSource[] {
  const packageEntries = scanDirectory({
    directory: input.packageBundlesDirectory,
    origin: "package",
  });
  const userEntries = scanDirectory({ directory: input.userBundlesDirectory, origin: "user" });

  const byName = new Map<string, DiscoveredSource>();
  for (const entry of packageEntries) {
    byName.set(entry.name, entry);
  }

  for (const entry of userEntries) {
    const shadowed = byName.get(entry.name);
    byName.set(entry.name, shadowed === undefined ? entry : { ...entry, shadows: shadowed.origin });
  }

  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

function scanDirectory(input: {
  readonly directory: string;
  readonly origin: SourceOrigin;
}): DiscoveredSource[] {
  if (!isDirectory(input.directory)) {
    return [];
  }

  const results: DiscoveredSource[] = [];
  for (const dirName of fs.readdirSync(input.directory).toSorted()) {
    const bundleDirectory = path.join(input.directory, dirName);
    if (!isDirectory(bundleDirectory)) {
      continue;
    }

    const manifestPath = path.join(bundleDirectory, "source.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    results.push(
      classify({ dirName, bundleDirectory, manifestPath, origin: input.origin }),
    );
  }

  return results;
}

function classify(input: {
  readonly dirName: string;
  readonly bundleDirectory: string;
  readonly manifestPath: string;
  readonly origin: SourceOrigin;
}): DiscoveredSource {
  const { dirName, bundleDirectory, origin } = input;

  let contents: string;
  try {
    contents = fs.readFileSync(input.manifestPath, "utf8");
  } catch (error) {
    return {
      status: "invalid",
      name: dirName,
      origin,
      bundleDirectory,
      warning: `could not read source.json in ${bundleDirectory}: ${messageOf(error)}`,
    };
  }

  const parsed = parseManifest(contents);
  if (!parsed.ok) {
    return {
      status: "invalid",
      name: dirName,
      origin,
      bundleDirectory,
      warning: `skipping source ${dirName}: ${parsed.reason}`,
    };
  }

  // Source name defaults to the manifest name, which defaults to the dir name (contracts §1).
  const name = parsed.manifest.name ?? dirName;
  const { protocolVersion } = parsed.manifest;

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return {
      status: "unsupported",
      name,
      origin,
      bundleDirectory,
      protocolVersion,
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      message: `source ${name} declares protocolVersion ${protocolVersion}; core supports ${formatSupported()}`,
    };
  }

  const hasUpdate = parsed.manifest.commands.update !== undefined;
  return {
    status: "ok",
    name,
    origin,
    bundleDirectory,
    manifest: parsed.manifest,
    protocolVersion,
    capabilities: {
      list: true,
      get: parsed.manifest.commands.get !== undefined,
      update: hasUpdate,
    },
    readOnly: !hasUpdate,
  };
}

function formatSupported(): string {
  return `{${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}}`;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
