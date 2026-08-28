import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSandboxSymlinkGrants } from "./sandboxSymlinkGrants.ts";

const writeErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>());
const debugMock = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeError: writeErrorMock,
    debug: debugMock,
  };
});

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError("Expected value to be defined");
  }

  return value;
}

describe(resolveSandboxSymlinkGrants, () => {
  let fakeHome: string;
  let dotfiles: string;
  let configDir: string;

  beforeEach(() => {
    // realpath so assertions compare against the same resolved form realpathSync
    // returns for the symlink targets (macOS /var → /private/var).
    fakeHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gc-symlink-home-")));
    dotfiles = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gc-symlink-dotfiles-")));
    configDir = path.join(fakeHome, ".claude");
    mkdirSync(configDir, { recursive: true });
    writeErrorMock.mockClear();
    debugMock.mockClear();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dotfiles, { recursive: true, force: true });
  });

  function link(entry: string, target: string): void {
    symlinkSync(target, path.join(configDir, entry));
  }

  function linkFile(entry: string): string {
    const target = path.join(dotfiles, entry);
    writeFileSync(target, "x");
    link(entry, target);
    return target;
  }

  function linkDirectory(entry: string): string {
    const target = path.join(dotfiles, entry);
    mkdirSync(target);
    link(entry, target);
    return target;
  }

  it("grants the resolved file for a file symlink, not its parent directory", () => {
    const settings = path.join(dotfiles, "settings.json");
    writeFileSync(settings, "{}");
    link("settings.json", settings);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([settings]);
    expect(actual).not.toContain(dotfiles);
  });

  it("grants the resolved directory for a directory symlink", () => {
    const skills = path.join(dotfiles, "skills");
    mkdirSync(skills);
    writeFileSync(path.join(skills, "SKILL.md"), "# skill");
    link("skills", skills);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([skills]);
  });

  it("resolves every dotfiles-managed config entry", () => {
    const fileEntries = ["settings.json", "CLAUDE.md", "mcp.json", "statusline-command.sh"];
    const directoryEntries = ["skills", "hooks", "agents", "commands", "contexts"];
    const expected = [
      ...fileEntries.map((entry) => linkFile(entry)),
      ...directoryEntries.map((entry) => linkDirectory(entry)),
    ];

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect([...actual].toSorted()).toEqual(expected.toSorted());
  });

  it("logs every auto-grant", () => {
    const settings = path.join(dotfiles, "settings.json");
    writeFileSync(settings, "{}");
    link("settings.json", settings);

    resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(debugMock).toHaveBeenCalledWith(expect.stringContaining(settings));
  });

  it("refuses a link resolving to $HOME and points at local.readOnlyDirs", () => {
    link("settings.json", fakeHome);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
    const [message] = assertDefined(writeErrorMock.mock.calls.at(0));
    expect(message).toContain(fakeHome);
    expect(message).toContain("local.readOnlyDirs");
  });

  it("refuses a link resolving to the filesystem root", () => {
    link("commands", "/");

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
    expect(writeErrorMock).toHaveBeenCalledWith(expect.stringContaining("local.readOnlyDirs"));
  });

  it("drops broken links", () => {
    link("settings.json", path.join(dotfiles, "missing.json"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("dedupes links that resolve to the same target", () => {
    const shared = path.join(dotfiles, "shared");
    mkdirSync(shared);
    link("skills", shared);
    link("commands", shared);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([shared]);
  });

  it("descends into real subdirectories to find nested links", () => {
    const skill = path.join(dotfiles, "my-skill");
    mkdirSync(skill);
    mkdirSync(path.join(configDir, "skills"));
    symlinkSync(skill, path.join(configDir, "skills", "my-skill"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([skill]);
  });

  it("stops descending past the walk depth bound", () => {
    const shallow = path.join(dotfiles, "shallow");
    const deep = path.join(dotfiles, "deep");
    mkdirSync(shallow);
    mkdirSync(deep);
    const atBound = path.join(configDir, "a", "b", "c");
    mkdirSync(path.join(atBound, "d"), { recursive: true });
    symlinkSync(shallow, path.join(atBound, "shallow"));
    symlinkSync(deep, path.join(atBound, "d", "deep"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([shallow]);
  });

  it("resolves a symlinked ~/.config/gh entry so gh can start in the sandbox", () => {
    const ghConfig = path.join(dotfiles, "gh-config.yml");
    writeFileSync(ghConfig, "version: 1\n");
    mkdirSync(path.join(fakeHome, ".config", "gh"), { recursive: true });
    symlinkSync(ghConfig, path.join(fakeHome, ".config", "gh", "config.yml"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([ghConfig]);
  });

  it("grants a tool config directory that is itself a symlink", () => {
    const ghDir = path.join(dotfiles, "gh");
    mkdirSync(ghDir);
    mkdirSync(path.join(fakeHome, ".config"), { recursive: true });
    symlinkSync(ghDir, path.join(fakeHome, ".config", "gh"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([ghDir]);
  });

  it("drops a tool config root that is a broken symlink", () => {
    symlinkSync(path.join(dotfiles, "missing-gitconfig"), path.join(fakeHome, ".gitconfig"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("grants a symlinked ~/.gitconfig file", () => {
    const gitConfig = path.join(dotfiles, "gitconfig");
    writeFileSync(gitConfig, "[user]\n");
    symlinkSync(gitConfig, path.join(fakeHome, ".gitconfig"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([gitConfig]);
  });

  it("grants an agent config directory that is itself a symlink", () => {
    rmSync(configDir, { recursive: true, force: true });
    const managed = path.join(dotfiles, "claude");
    mkdirSync(managed);
    symlinkSync(managed, configDir);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([managed]);
  });

  it("ignores a real, unmanaged tool config file", () => {
    writeFileSync(path.join(fakeHome, ".gitconfig"), "[user]\n");

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("still resolves tool configs for an agent with no registered config directory", () => {
    const ghConfig = path.join(dotfiles, "gh-config.yml");
    writeFileSync(ghConfig, "version: 1\n");
    mkdirSync(path.join(fakeHome, ".config", "gh"), { recursive: true });
    symlinkSync(ghConfig, path.join(fakeHome, ".config", "gh", "config.yml"));

    const actual = resolveSandboxSymlinkGrants({ agent: "codex", homeDir: fakeHome });

    expect(actual).toEqual([ghConfig]);
  });

  it("ignores the agent config directory of an agent with no registered entry", () => {
    const settings = path.join(dotfiles, "settings.json");
    writeFileSync(settings, "{}");
    link("settings.json", settings);

    const actual = resolveSandboxSymlinkGrants({ agent: "codex", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("returns nothing when the home directory itself is absent", () => {
    const actual = resolveSandboxSymlinkGrants({
      agent: "claude",
      homeDir: path.join(fakeHome, "no-such-home"),
    });

    expect(actual).toEqual([]);
  });

  it("returns nothing when the config directory is absent", () => {
    rmSync(configDir, { recursive: true, force: true });

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });
});
