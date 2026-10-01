/**
 * `crew stage` — operator commands for `pr-stage-sync`'s two gating labels
 * (`label-add` / `label-remove`) and an on-demand sync pass (`refresh`).
 * Labels are restricted to the two names configured under
 * `cmux.prStages.labels`; each is created in the PR's repo on first use with
 * a fixed color so the two gates stay visually distinct in GitHub's label UI.
 */

import { runCommandAsync } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { worktrees } from "../lib/worktrees.ts";
import { createPrStageSync, createPrStageSyncDeps } from "./prStageSync.ts";

const PULL_REQUEST_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;

type LabelRole = "selfReviewed" | "tested";

const LABEL_COLORS: Record<LabelRole, string> = {
  selfReviewed: "5319E7",
  tested: "0E8A16",
};

const STAGE_USAGE = `Usage: crew stage <subcommand>

Subcommands:
  label-add <pr-url> <label>     Add a configured gating label to a pull request
  label-remove <pr-url> <label>  Remove a configured gating label from a pull request
  refresh                        Run one pr-stage-sync pass now`;

interface ParsedPullRequestUrl {
  owner: string;
  repo: string;
}

function parsePullRequestUrl(url: string): ParsedPullRequestUrl {
  const match = PULL_REQUEST_URL_PATTERN.exec(url);
  const [, owner, repo] = match ?? [];
  if (owner === undefined || repo === undefined) {
    throw new Error(
      `crew stage: invalid pull request URL: ${url}\nExpected https://github.com/<owner>/<repo>/pull/<number>`,
    );
  }
  return { owner, repo };
}

function resolveLabelRole(
  label: string,
  labels: ResolvedConfig["cmux"]["prStages"]["labels"],
): LabelRole {
  if (label === labels.selfReviewed) {
    return "selfReviewed";
  }
  if (label === labels.tested) {
    return "tested";
  }
  throw new Error(
    `crew stage: unknown label: ${label}\nConfigured labels are "${labels.selfReviewed}" and "${labels.tested}" (cmux.prStages.labels).`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGithubLabelNamed(value: unknown, label: string): boolean {
  return isRecord(value) && value["name"] === label;
}

async function labelExists(repo: string, label: string): Promise<boolean> {
  const output = await runCommandAsync("gh", [
    "label",
    "list",
    "--repo",
    repo,
    "--search",
    label,
    "--json",
    "name",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  return parsed.some((entry) => isGithubLabelNamed(entry, label));
}

async function ensureLabelExists(repo: string, label: string, role: LabelRole): Promise<void> {
  if (await labelExists(repo, label)) {
    return;
  }
  await runCommandAsync("gh", [
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--color",
    LABEL_COLORS[role],
    "--force",
  ]);
}

async function syncOnce(config: ResolvedConfig): Promise<void> {
  const prStageSync = createPrStageSync(createPrStageSyncDeps(config));
  const worktreeEntries = worktrees.list(config);
  await prStageSync.syncOnce({ worktreeEntries });
}

interface LabelCliArgs {
  prUrl: string;
  label: string;
}

function parseLabelCliArgs(argv: string[], usage: string): LabelCliArgs {
  const [prUrl, label, ...extras] = argv;
  if (prUrl === undefined || label === undefined || extras.length > 0) {
    throw new Error(usage);
  }
  return { prUrl, label };
}

const LABEL_ADD_USAGE = "Usage: crew stage label-add <pr-url> <label>";
const LABEL_REMOVE_USAGE = "Usage: crew stage label-remove <pr-url> <label>";

async function stageLabelAddCli(argv: string[]): Promise<void> {
  const { prUrl, label } = parseLabelCliArgs(argv, LABEL_ADD_USAGE);
  const config = await loadConfig();
  const role = resolveLabelRole(label, config.cmux.prStages.labels);
  const { repo: repoName, owner } = parsePullRequestUrl(prUrl);
  const repo = `${owner}/${repoName}`;
  await ensureLabelExists(repo, label, role);
  await runCommandAsync("gh", ["pr", "edit", prUrl, "--add-label", label]);
  await syncOnce(config);
}

async function stageLabelRemoveCli(argv: string[]): Promise<void> {
  const { prUrl, label } = parseLabelCliArgs(argv, LABEL_REMOVE_USAGE);
  const config = await loadConfig();
  resolveLabelRole(label, config.cmux.prStages.labels);
  await runCommandAsync("gh", ["pr", "edit", prUrl, "--remove-label", label]);
  await syncOnce(config);
}

async function stageRefreshCli(argv: string[]): Promise<void> {
  if (argv.length > 0) {
    throw new Error("Usage: crew stage refresh");
  }
  const config = await loadConfig();
  await syncOnce(config);
}

export async function stageCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "label-add") {
    await stageLabelAddCli(rest);
    return;
  }
  if (verb === "label-remove") {
    await stageLabelRemoveCli(rest);
    return;
  }
  if (verb === "refresh") {
    await stageRefreshCli(rest);
    return;
  }
  throw new Error(STAGE_USAGE);
}
