import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { codexProjectTableHeader } from "./agentWorkspaceTrust.ts";

const GROUNDCREW_TRUST_METHOD = "groundcrew-auto-trust";
const CODEX_PROJECT_HEADER_PATTERN = /\[projects\."((?:[^"\\]|\\.)*)"\]/g;

export type AgentTrustAgent = "cursor" | "claude" | "codex";

export interface AgentTrustEntry {
  agent: AgentTrustAgent;
  workspacePath: string;
  detail: string;
  store: string;
}

export interface ListAgentWorkspaceTrustInput {
  homeDir: string;
  agent?: AgentTrustAgent;
  /** When true, only return entries whose workspace path no longer exists. */
  missingOnly?: boolean;
}

export interface DeleteAgentWorkspaceTrustInput {
  homeDir: string;
  agent?: AgentTrustAgent;
  /** Delete trust for this exact absolute workspace path. */
  path?: string;
  /** Delete trust for every path under this directory prefix. */
  pathPrefix?: string;
  /** Delete every listed trust entry (subject to `agent` / `groundcrewOnly`). */
  all?: boolean;
  /** Cursor only: delete markers seeded by groundcrew (`trustMethod: groundcrew-auto-trust`). */
  groundcrewOnly?: boolean;
}

export interface DeleteAgentWorkspaceTrustResult {
  agent: AgentTrustAgent;
  workspacePath: string;
  deleted: boolean;
}

export interface PruneAgentWorkspaceTrustInput {
  homeDir: string;
  agent?: AgentTrustAgent;
}

function workspacePathExists(workspacePath: string): boolean {
  try {
    return existsSync(workspacePath);
  } catch {
    return false;
  }
}

function isMissingWorkspaceTrustEntry(entry: AgentTrustEntry): boolean {
  return !workspacePathExists(entry.workspacePath);
}

/** Whether the trusted workspace path no longer exists on disk. */
export function isMissingAgentTrustEntry(entry: AgentTrustEntry): boolean {
  return isMissingWorkspaceTrustEntry(entry);
}

interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  [key: string]: unknown;
}

interface ClaudeJsonFile {
  projects?: Record<string, ClaudeProjectEntry>;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unescapeTomlDoubleQuotedString(value: string): string {
  return value.replaceAll("\\\\", "\\").replaceAll('\\"', '"');
}

function cursorProjectsDir(homeDir: string): string {
  return path.join(homeDir, ".cursor", "projects");
}

function claudeJsonPath(homeDir: string): string {
  return path.join(homeDir, ".claude.json");
}

function codexConfigPath(homeDir: string): string {
  return path.join(homeDir, ".codex", "config.toml");
}

function codexProjectSectionBody(
  config: string,
  headerIndex: number,
  headerLength: number,
): string {
  const afterHeader = config.slice(headerIndex + headerLength);
  const nextSection = afterHeader.search(/^\[/m);
  return nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
}

function readClaudeJson(jsonPath: string): ClaudeJsonFile {
  if (!existsSync(jsonPath)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaudeJson(jsonPath: string, contents: ClaudeJsonFile): void {
  const tmpPath = `${jsonPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(contents, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, jsonPath);
}

function writeCodexConfig(codexConfig: string, contents: string): void {
  const tmpPath = `${codexConfig}.${process.pid}.tmp`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, codexConfig);
}

interface CursorWorkspaceTrustedMarker {
  workspacePath?: string;
  trustMethod?: string;
}

function parseCursorMarker(raw: string): CursorWorkspaceTrustedMarker | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function readCodexConfig(codexConfig: string): string {
  if (!existsSync(codexConfig)) {
    return "";
  }
  try {
    return readFileSync(codexConfig, "utf8");
  } catch {
    return "";
  }
}

function listCursorTrustEntries(homeDir: string): AgentTrustEntry[] {
  const projectsDir = cursorProjectsDir(homeDir);
  if (!existsSync(projectsDir)) {
    return [];
  }

  const entries: AgentTrustEntry[] = [];
  for (const slug of readdirSync(projectsDir)) {
    const markerPath = path.join(projectsDir, slug, ".workspace-trusted");
    if (!existsSync(markerPath)) {
      continue;
    }
    let workspacePath = path.resolve(`/${slug.replaceAll("-", "/")}`);
    let detail = "trusted";
    const marker = parseCursorMarker(readFileSync(markerPath, "utf8"));
    if (marker === undefined) {
      detail = "trusted (unparseable marker)";
    } else {
      if (typeof marker.workspacePath === "string") {
        workspacePath = marker.workspacePath;
      }
      if (typeof marker.trustMethod === "string") {
        detail = marker.trustMethod;
      }
    }
    entries.push({
      agent: "cursor",
      workspacePath: path.resolve(workspacePath),
      detail,
      store: markerPath,
    });
  }
  return entries.toSorted((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}

function listClaudeTrustEntries(homeDir: string): AgentTrustEntry[] {
  const claudeJson = readClaudeJson(claudeJsonPath(homeDir));
  const projects = claudeJson.projects ?? {};
  const entries: AgentTrustEntry[] = [];
  for (const [workspacePath, project] of Object.entries(projects)) {
    if (project.hasTrustDialogAccepted !== true) {
      continue;
    }
    entries.push({
      agent: "claude",
      workspacePath: path.resolve(workspacePath),
      detail: "hasTrustDialogAccepted",
      store: `${claudeJsonPath(homeDir)}#projects`,
    });
  }
  return entries.toSorted((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}

export function listCodexTrustedProjects(
  config: string,
): Array<{ path: string; trustLevel: string }> {
  const entries: Array<{ path: string; trustLevel: string }> = [];
  for (const match of config.matchAll(CODEX_PROJECT_HEADER_PATTERN)) {
    const rawPath = match[1];
    if (rawPath === undefined) {
      continue;
    }
    const workspacePath = path.resolve(unescapeTomlDoubleQuotedString(rawPath));
    const header = match[0];
    const headerIndex = match.index ?? config.indexOf(header);
    const sectionBody = codexProjectSectionBody(config, headerIndex, header.length);
    const trustMatch = /trust_level\s*=\s*"([^"]*)"/.exec(sectionBody);
    if (trustMatch?.[1] === undefined) {
      continue;
    }
    entries.push({ path: workspacePath, trustLevel: trustMatch[1] });
  }
  return entries.toSorted((a, b) => a.path.localeCompare(b.path));
}

function listCodexTrustEntries(homeDir: string): AgentTrustEntry[] {
  const codexConfig = codexConfigPath(homeDir);
  return listCodexTrustedProjects(readCodexConfig(codexConfig)).map((entry) => ({
    agent: "codex" as const,
    workspacePath: entry.path,
    detail: `trust_level=${entry.trustLevel}`,
    store: codexConfig,
  }));
}

/** List workspace trust entries recorded for Cursor, Claude, and Codex. */
export function listAgentWorkspaceTrust(input: ListAgentWorkspaceTrustInput): AgentTrustEntry[] {
  const agents: AgentTrustAgent[] =
    input.agent === undefined ? ["cursor", "claude", "codex"] : [input.agent];
  const entries: AgentTrustEntry[] = [];
  if (agents.includes("cursor")) {
    entries.push(...listCursorTrustEntries(input.homeDir));
  }
  if (agents.includes("claude")) {
    entries.push(...listClaudeTrustEntries(input.homeDir));
  }
  if (agents.includes("codex")) {
    entries.push(...listCodexTrustEntries(input.homeDir));
  }
  const filtered =
    input.missingOnly === true ? entries.filter(isMissingWorkspaceTrustEntry) : entries;
  return filtered.toSorted((a, b) => {
    const agentOrder = a.agent.localeCompare(b.agent);
    return agentOrder === 0 ? a.workspacePath.localeCompare(b.workspacePath) : agentOrder;
  });
}

function normalizedPrefix(prefix: string): string {
  const resolved = path.resolve(prefix);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

function matchesDeleteTarget(
  entry: AgentTrustEntry,
  input: DeleteAgentWorkspaceTrustInput,
): boolean {
  if (input.agent !== undefined && entry.agent !== input.agent) {
    return false;
  }
  if (
    input.groundcrewOnly === true &&
    (entry.agent !== "cursor" || entry.detail !== GROUNDCREW_TRUST_METHOD)
  ) {
    return false;
  }
  if (input.all === true) {
    return true;
  }
  if (input.path !== undefined) {
    return path.resolve(entry.workspacePath) === path.resolve(input.path);
  }
  if (input.pathPrefix !== undefined) {
    const prefix = normalizedPrefix(input.pathPrefix);
    const resolved = `${path.resolve(entry.workspacePath)}${path.sep}`;
    return resolved.startsWith(prefix);
  }
  /* v8 ignore next @preserve */
  return false;
}

function deleteCursorTrustEntry(markerPath: string): boolean {
  if (!existsSync(markerPath)) {
    /* v8 ignore next @preserve */
    return false;
  }
  rmSync(markerPath);
  return true;
}

function deleteClaudeTrustEntry(homeDir: string, workspacePath: string): boolean {
  const claudeJsonFile = claudeJsonPath(homeDir);
  const claudeJson = readClaudeJson(claudeJsonFile);
  const projects = claudeJson.projects ?? {};
  const existing = projects[workspacePath];
  if (existing?.hasTrustDialogAccepted !== true) {
    /* v8 ignore next @preserve */
    return false;
  }

  const {
    hasTrustDialogAccepted: _trust,
    hasCompletedProjectOnboarding: _onboarding,
    ...rest
  } = existing;
  if (Object.keys(rest).length === 0) {
    const { [workspacePath]: _removed, ...remainingProjects } = projects;
    claudeJson.projects = remainingProjects;
  } else {
    projects[workspacePath] = rest;
    claudeJson.projects = projects;
  }
  writeClaudeJson(claudeJsonFile, claudeJson);
  return true;
}

export function removeCodexProjectTrust(config: string, absoluteWorkspacePath: string): string {
  const header = codexProjectTableHeader(absoluteWorkspacePath);
  const headerIndex = config.indexOf(header);
  if (headerIndex === -1) {
    return config;
  }

  const sectionBody = codexProjectSectionBody(config, headerIndex, header.length);
  const sectionEnd = headerIndex + header.length + sectionBody.length;
  const withoutTrust = sectionBody.replace(/^\s*trust_level\s*=\s*"[^"]*"\s*\n?/m, "");
  const remainingKeys = withoutTrust
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (remainingKeys.length === 0) {
    let updated = `${config.slice(0, headerIndex)}${config.slice(sectionEnd)}`;
    updated = updated.replaceAll(/\n{3,}/g, "\n\n").replace(/\n+$/u, "\n");
    return updated;
  }

  return `${config.slice(0, headerIndex + header.length)}${withoutTrust}${config.slice(sectionEnd)}`;
}

function deleteCodexTrustEntry(homeDir: string, workspacePath: string): boolean {
  const codexConfig = codexConfigPath(homeDir);
  const existing = readCodexConfig(codexConfig);
  const updated = removeCodexProjectTrust(existing, workspacePath);
  if (updated === existing) {
    /* v8 ignore next @preserve */
    return false;
  }
  writeCodexConfig(codexConfig, updated);
  return true;
}

function deleteTrustEntry(homeDir: string, entry: AgentTrustEntry): boolean {
  switch (entry.agent) {
    case "cursor": {
      return deleteCursorTrustEntry(entry.store);
    }
    case "claude": {
      return deleteClaudeTrustEntry(homeDir, entry.workspacePath);
    }
    case "codex": {
      return deleteCodexTrustEntry(homeDir, entry.workspacePath);
    }
    default: {
      /* v8 ignore next @preserve */
      const _exhaustive: never = entry.agent;
      return _exhaustive;
    }
  }
}

/** Delete workspace trust entries from Cursor, Claude, and/or Codex stores. */
export function deleteAgentWorkspaceTrust(
  input: DeleteAgentWorkspaceTrustInput,
): DeleteAgentWorkspaceTrustResult[] {
  const hasTarget =
    input.all === true || input.path !== undefined || input.pathPrefix !== undefined;
  if (!hasTarget) {
    throw new Error("delete requires --all, --path, or --prefix");
  }

  const targets = listAgentWorkspaceTrust({
    homeDir: input.homeDir,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  }).filter((entry) => matchesDeleteTarget(entry, input));

  const results: DeleteAgentWorkspaceTrustResult[] = [];
  for (const entry of targets) {
    results.push({
      agent: entry.agent,
      workspacePath: entry.workspacePath,
      deleted: deleteTrustEntry(input.homeDir, entry),
    });
  }
  return results;
}

/** Remove trust entries whose workspace paths no longer exist on disk. */
export function pruneAgentWorkspaceTrust(
  input: PruneAgentWorkspaceTrustInput,
): DeleteAgentWorkspaceTrustResult[] {
  const staleEntries = listAgentWorkspaceTrust({
    homeDir: input.homeDir,
    missingOnly: true,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  });

  const results: DeleteAgentWorkspaceTrustResult[] = [];
  for (const entry of staleEntries) {
    results.push({
      agent: entry.agent,
      workspacePath: entry.workspacePath,
      deleted: deleteTrustEntry(input.homeDir, entry),
    });
  }
  return results;
}
