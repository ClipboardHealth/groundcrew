/**
 * `crew source list` and `crew source doctor` (design §7.1, contracts §7).
 * `list` shows every discovered bundle with origin, protocol, capabilities,
 * sandbox posture, and egress — flagging unsupported protocols and user-dir
 * overrides (PLUGIN-01/02/05). `doctor` runs the per-source deep check and exits
 * 1 naming the failing source (SURFACE-07).
 */
import type { DiscoveredSource } from "../../acquisition/index.js";
import { type CheckResult, checkSource } from "../checks.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";
import { renderChecks } from "../render/doctor.js";

interface SourceListRow {
  readonly name: string;
  readonly origin: string;
  readonly protocol: string;
  readonly capabilities: string;
  readonly sandbox: string;
  readonly egress: string;
  readonly overrides: string | undefined;
}

export function runSourceList(input: {
  readonly context: Context;
  readonly json: boolean;
  readonly io: Io;
}): void {
  const rows = listRows(input.context);

  if (input.json) {
    input.io.out(JSON.stringify(rows, undefined, 2));
    return;
  }

  input.io.out(renderTable(rows));

  // Nothing is silently dropped: an unparseable/unsupported bundle is warned
  // about by name, and discovery proceeds for the rest (PLUGIN-03/04).
  for (const warning of discoveryWarnings(input.context)) {
    input.io.err(`warning: ${warning}`);
  }
}

function discoveryWarnings(context: Context): string[] {
  const warnings: string[] = [];
  for (const discovered of context.discovered()) {
    if (discovered.status === "invalid") {
      warnings.push(discovered.warning);
    } else if (discovered.status === "unsupported") {
      warnings.push(discovered.message);
    }
  }

  return warnings;
}

export async function runSourceDoctor(input: {
  readonly context: Context;
  readonly name?: string;
  readonly json: boolean;
  readonly io: Io;
}): Promise<number> {
  const resolved = input.context
    .resolvedSources()
    .filter((source) => input.name === undefined || source.name === input.name);

  if (resolved.length === 0) {
    input.io.err(
      input.name === undefined
        ? "no sources are configured"
        : `no configured source named "${input.name}"`,
    );
    return 1;
  }

  const checks: CheckResult[] = [];
  for (const source of resolved) {
    // eslint-disable-next-line no-await-in-loop -- sources are checked in order for stable output
    checks.push(...(await checkSource({ context: input.context, resolved: source })));
  }

  if (input.json) {
    input.io.out(JSON.stringify(checks, undefined, 2));
  } else {
    input.io.out(renderChecks({ title: "Source health", checks }));
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

function listRows(context: Context): SourceListRow[] {
  const configByKind = new Map(
    (context.config.sources ?? []).map((entry) => [entry.kind, entry] as const),
  );

  return context.discovered().map((discovered) => {
    const entry = configByKind.get(discovered.name);
    const sandboxOff = entry?.sandbox === false;
    return {
      name: entry?.name ?? discovered.name,
      origin: discovered.origin,
      protocol: protocolOf(discovered),
      capabilities: capabilitiesOf(discovered),
      sandbox: sandboxOff ? "OFF" : "sandboxed",
      egress: egressOf(discovered),
      overrides: discovered.shadows === undefined ? undefined : `overrides ${discovered.shadows}`,
    };
  });
}

function protocolOf(discovered: DiscoveredSource): string {
  switch (discovered.status) {
    case "ok": {
      return String(discovered.protocolVersion);
    }
    case "unsupported": {
      return `${String(discovered.protocolVersion)} (unsupported; supported: ${discovered.supportedVersions.join(", ")})`;
    }
    case "invalid": {
      return "invalid";
    }
    default: {
      throw new Error("unreachable discovered source status");
    }
  }
}

function capabilitiesOf(discovered: DiscoveredSource): string {
  if (discovered.status !== "ok") {
    return "-";
  }

  const capabilities = ["list"];
  if (discovered.capabilities.get) {
    capabilities.push("get");
  }

  if (discovered.capabilities.update) {
    capabilities.push("update");
  } else {
    capabilities.push("(read-only)");
  }

  return capabilities.join(",");
}

function egressOf(discovered: DiscoveredSource): string {
  if (discovered.status !== "ok") {
    return "-";
  }

  return discovered.manifest.network.length === 0 ? "none" : discovered.manifest.network.join(",");
}

function renderTable(rows: readonly SourceListRow[]): string {
  const header = ["NAME", "ORIGIN", "PROTOCOL", "CAPABILITIES", "SANDBOX", "EGRESS"];
  if (rows.length === 0) {
    return `${header.join("  ")}\n(no sources discovered)`;
  }

  const matrix = [
    header,
    ...rows.map((row) => [
      row.name + (row.overrides === undefined ? "" : ` (${row.overrides})`),
      row.origin,
      row.protocol,
      row.capabilities,
      row.sandbox,
      row.egress,
    ]),
  ];

  const widths = header.map((_, column) =>
    Math.max(...matrix.map((cells) => (cells[column] ?? "").length)),
  );

  return matrix
    .map((cells) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd())
    .join("\n");
}
