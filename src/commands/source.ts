import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { loadConfig } from "../lib/config.ts";
import { summarizeSource, type SourceSummary } from "../lib/sourceCapabilities.ts";
import { errorMessage, parseSourceFilterArgs, writeOutput } from "../lib/util.ts";

const SOURCE_USAGE = `Usage: crew source <subcommand>

Subcommands:
  list [--json]              List configured sources and their capabilities
  verify [source] [--json]   Verify one or all configured sources`;

async function sourceListCli(argv: string[]): Promise<void> {
  let jsonOutput = false;
  for (const arg of argv) {
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    throw new Error(`crew source list: unknown argument: ${arg}\nUsage: crew source list [--json]`);
  }

  const config = await loadConfig();
  const rawSources = sourcesFromConfig(config);
  const summaries = rawSources.map(summarizeSource);

  if (jsonOutput) {
    writeOutput(JSON.stringify(summaries, null, 2));
    return;
  }

  printSourceTable(summaries);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function printSourceTable(summaries: SourceSummary[]): void {
  if (summaries.length === 0) {
    writeOutput("(no sources configured)");
    return;
  }

  const nameWidth = Math.max(4, ...summaries.map((s) => s.name.length));
  const kindWidth = Math.max(4, ...summaries.map((s) => s.kind.length));

  const header = [
    "NAME".padEnd(nameWidth),
    "KIND".padEnd(kindWidth),
    "VERIFY".padEnd(6),
    "LIST TASKS".padEnd(10),
    "GET TASK".padEnd(8),
    "CREATE".padEnd(6),
    "VALIDATE".padEnd(8),
    "WRITEBACK",
  ].join("  ");
  writeOutput(header);

  for (const summary of summaries) {
    const { capabilities: cap } = summary;
    const writeback = cap.markInProgress || cap.markInReview || cap.markDone;
    const row = [
      summary.name.padEnd(nameWidth),
      summary.kind.padEnd(kindWidth),
      yesNo(cap.verify).padEnd(6),
      yesNo(cap.listTasks).padEnd(10),
      yesNo(cap.getTask).padEnd(8),
      yesNo(cap.createTask).padEnd(6),
      yesNo(cap.validate).padEnd(8),
      yesNo(writeback),
    ].join("  ");
    writeOutput(row);
  }
}

interface VerifyResult {
  source: string;
  ok: boolean;
  message?: string;
}

async function sourceVerifyCli(argv: string[]): Promise<void> {
  const { targetSource, jsonOutput } = parseSourceFilterArgs(
    argv,
    "crew source verify",
    "Usage: crew source verify [source] [--json]",
  );

  const config = await loadConfig();
  const rawSources = sourcesFromConfig(config);
  const allSources = await buildSources(rawSources, { globalConfig: config });

  let sources = allSources;
  if (targetSource !== undefined) {
    sources = allSources.filter((s) => s.name === targetSource);
    if (sources.length === 0) {
      throw new Error(`crew source verify: no source named "${targetSource}"`);
    }
  }

  const results: VerifyResult[] = await Promise.all(
    sources.map(async (source) => {
      try {
        await source.verify();
        return { source: source.name, ok: true };
      } catch (error) {
        return { source: source.name, ok: false, message: errorMessage(error) };
      }
    }),
  );

  if (jsonOutput) {
    writeOutput(JSON.stringify(results, null, 2));
  } else {
    const nameWidth = Math.max(...results.map((r) => r.source.length));
    for (const result of results) {
      const parts = [result.source.padEnd(nameWidth), result.ok ? "ok" : "failed"];
      if (!result.ok && result.message !== undefined) {
        parts.push(result.message);
      }
      writeOutput(parts.join("  "));
    }
  }

  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

export async function sourceCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "list") {
    await sourceListCli(rest);
    return;
  }
  if (verb === "verify") {
    await sourceVerifyCli(rest);
    return;
  }
  throw new Error(SOURCE_USAGE);
}
