import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeError } from "./util.ts";

const GROUNDCREW_TRUST_METHOD = "groundcrew-auto-trust";

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

  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, "utf8");
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
  }
}
