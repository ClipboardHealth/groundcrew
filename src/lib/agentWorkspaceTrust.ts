import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeError } from "./util.ts";

const GROUNDCREW_TRUST_METHOD = "groundcrew-auto-trust";
const CODEX_TRUST_LEVEL = "trusted";

interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  [key: string]: unknown;
}

interface ClaudeJsonFile {
  projects?: Record<string, ClaudeProjectEntry>;
  [key: string]: unknown;
}

interface CursorWorkspaceTrustedMarker {
  trustedAt: string;
  workspacePath: string;
  trustMethod: string;
}

export interface SeedAgentWorkspaceTrustInput {
  agentCommandName: string;
  workspacePath: string;
  /** Defaults to `os.homedir()`. Injected in tests. */
  homeDir?: string;
  /** Test seam for `os.homedir()` failures. Not used by production callers. */
  readHome?: () => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveHomeDir(
  homeDir: string | undefined,
  readHome: () => string = homedir,
): string | undefined {
  try {
    return homeDir ?? readHome();
  } catch {
    return undefined;
  }
}

/** Cursor keys project metadata under `~/.cursor/projects/<slug>/`. */
export function cursorProjectSlug(workspacePath: string): string {
  return path.resolve(workspacePath).replace(/^\//, "").replaceAll("/", "-");
}

function cursorWorkspaceTrustedPath(home: string, workspacePath: string): string {
  const slug = cursorProjectSlug(workspacePath);
  return path.join(home, ".cursor", "projects", slug, ".workspace-trusted");
}

function seedCursorWorkspaceTrust(workspacePath: string, home: string): void {
  const markerPath = cursorWorkspaceTrustedPath(home, workspacePath);
  if (existsSync(markerPath)) {
    return;
  }

  const absoluteWorkspacePath = path.resolve(workspacePath);
  const marker: CursorWorkspaceTrustedMarker = {
    trustedAt: new Date().toISOString(),
    workspacePath: absoluteWorkspacePath,
    trustMethod: GROUNDCREW_TRUST_METHOD,
  };

  try {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, "utf8");
  } catch (error) {
    writeError(
      `groundcrew: could not seed Cursor workspace trust for ${absoluteWorkspacePath} (${String(error)})`,
    );
  }
}

function readClaudeJsonFile(claudeJsonPath: string): ClaudeJsonFile {
  try {
    const raw = readFileSync(claudeJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      writeError(
        `groundcrew: ${claudeJsonPath} is not a JSON object; seeding workspace trust from a fresh file`,
      );
      return {};
    }
    const projects = parsed["projects"];
    if (projects !== undefined && !isPlainObject(projects)) {
      writeError(
        `groundcrew: ${claudeJsonPath} has an invalid projects field; seeding workspace trust from a fresh file`,
      );
      const { projects: _ignored, ...rest } = parsed;
      return rest;
    }
    return parsed;
  } catch (error) {
    if (existsSync(claudeJsonPath)) {
      writeError(
        `groundcrew: could not read ${claudeJsonPath} for workspace trust (${String(error)}); seeding from a fresh file`,
      );
    }
    return {};
  }
}

function writeClaudeJsonFile(claudeJsonPath: string, contents: ClaudeJsonFile): void {
  mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
  const tmpPath = `${claudeJsonPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(contents, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, claudeJsonPath);
}

function seedClaudeWorkspaceTrust(workspacePath: string, home: string): void {
  const claudeJsonPath = path.join(home, ".claude.json");
  const absoluteWorkspacePath = path.resolve(workspacePath);
  const claudeJson = readClaudeJsonFile(claudeJsonPath);
  const projects = claudeJson.projects ?? {};
  const existing = projects[absoluteWorkspacePath];

  if (existing?.hasTrustDialogAccepted === true) {
    return;
  }

  projects[absoluteWorkspacePath] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  claudeJson.projects = projects;

  try {
    writeClaudeJsonFile(claudeJsonPath, claudeJson);
  } catch (error) {
    writeError(
      `groundcrew: could not seed Claude workspace trust for ${absoluteWorkspacePath} (${String(error)})`,
    );
  }
}

function escapeTomlDoubleQuotedString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Codex keys per-workspace trust under `[projects."<abs-path>"]` in `config.toml`. */
export function codexProjectTableHeader(absoluteWorkspacePath: string): string {
  return `[projects."${escapeTomlDoubleQuotedString(absoluteWorkspacePath)}"]`;
}

function codexConfigPath(home: string): string {
  return path.join(home, ".codex", "config.toml");
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

function hasCodexWorkspaceTrust(config: string, absoluteWorkspacePath: string): boolean {
  const header = codexProjectTableHeader(absoluteWorkspacePath);
  const headerIndex = config.indexOf(header);
  if (headerIndex === -1) {
    return false;
  }
  const sectionBody = codexProjectSectionBody(config, headerIndex, header.length);
  return /trust_level\s*=\s*"trusted"/.test(sectionBody);
}

function upsertCodexWorkspaceTrust(config: string, absoluteWorkspacePath: string): string {
  if (hasCodexWorkspaceTrust(config, absoluteWorkspacePath)) {
    return config;
  }

  const header = codexProjectTableHeader(absoluteWorkspacePath);
  const headerIndex = config.indexOf(header);
  if (headerIndex === -1) {
    const separator = config.length === 0 ? "" : config.endsWith("\n") ? "" : "\n";
    return `${config}${separator}${header}\ntrust_level = "${CODEX_TRUST_LEVEL}"\n`;
  }

  const sectionBody = codexProjectSectionBody(config, headerIndex, header.length);
  const sectionEnd = headerIndex + header.length + sectionBody.length;
  if (/trust_level\s*=/.test(sectionBody)) {
    const updatedSection = sectionBody.replace(
      /trust_level\s*=\s*"[^"]*"/,
      `trust_level = "${CODEX_TRUST_LEVEL}"`,
    );
    return `${config.slice(0, headerIndex + header.length)}${updatedSection}${config.slice(sectionEnd)}`;
  }

  const insertion = sectionBody.endsWith("\n")
    ? `trust_level = "${CODEX_TRUST_LEVEL}"\n`
    : `\ntrust_level = "${CODEX_TRUST_LEVEL}"\n`;
  return `${config.slice(0, sectionEnd)}${insertion}${config.slice(sectionEnd)}`;
}

function writeCodexConfigFile(codexConfig: string, contents: string): void {
  mkdirSync(path.dirname(codexConfig), { recursive: true });
  const tmpPath = `${codexConfig}.${process.pid}.tmp`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, codexConfig);
}

function readCodexConfigFile(codexConfig: string): string {
  try {
    return readFileSync(codexConfig, "utf8");
  } catch (error) {
    if (existsSync(codexConfig)) {
      writeError(
        `groundcrew: could not read ${codexConfig} for workspace trust (${String(error)}); seeding from a fresh file`,
      );
    }
    return "";
  }
}

function seedCodexWorkspaceTrust(workspacePath: string, home: string): void {
  const absoluteWorkspacePath = path.resolve(workspacePath);
  const codexConfig = codexConfigPath(home);
  const existing = readCodexConfigFile(codexConfig);
  const updated = upsertCodexWorkspaceTrust(existing, absoluteWorkspacePath);
  if (updated === existing) {
    return;
  }

  try {
    writeCodexConfigFile(codexConfig, updated);
  } catch (error) {
    writeError(
      `groundcrew: could not seed Codex workspace trust for ${absoluteWorkspacePath} (${String(error)})`,
    );
  }
}

/** Seed agent-specific workspace trust stores before the first interactive launch. */
export function seedAgentWorkspaceTrust(input: SeedAgentWorkspaceTrustInput): void {
  const home = resolveHomeDir(input.homeDir, input.readHome);
  if (home === undefined) {
    writeError("groundcrew: could not resolve home directory for workspace trust seeding");
    return;
  }

  const { agentCommandName, workspacePath } = input;
  if (agentCommandName === "cursor-agent") {
    seedCursorWorkspaceTrust(workspacePath, home);
    return;
  }
  if (agentCommandName === "claude") {
    seedClaudeWorkspaceTrust(workspacePath, home);
    return;
  }
  if (agentCommandName === "codex") {
    seedCodexWorkspaceTrust(workspacePath, home);
  }
}
