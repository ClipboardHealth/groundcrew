import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSandboxSymlinkGrants } from "./sandboxSymlinkGrants.ts";

const writeErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>());
const logMock = vi.hoisted(() => vi.fn<(message: string) => void>());
const runCommandMock = vi.hoisted(() => vi.fn<() => string>());
const debugMock = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeError: writeErrorMock,
    debug: debugMock,
    log: logMock,
  };
});
// Never read the developer's real git config from a unit test; each case seeds
// the `git config --list --show-origin --name-only -z` output it needs.
vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
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
    logMock.mockClear();
    runCommandMock.mockReset();
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dotfiles, { recursive: true, force: true });
  });

  /** Seed the NUL-separated `<scope>`, `<origin>`, `<name>` triples git emits. */
  function seedGitConfigOrigins(...files: readonly string[]): void {
    seedGitConfigScopes(...files.map((file) => ({ scope: "global", file })));
  }

  function seedGitConfigScopes(...entries: ReadonlyArray<{ scope: string; file: string }>): void {
    runCommandMock.mockReturnValue(
      entries.map(({ scope, file }) => `${scope}\0file:${file}\0user.name`).join("\0"),
    );
  }

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
    // Six levels below the config dir reach the bound; the seventh is past it.
    const atBound = path.join(configDir, "skills", "a", "b", "c", "d", "e");
    mkdirSync(path.join(atBound, "f"), { recursive: true });
    symlinkSync(shallow, path.join(atBound, "shallow"));
    symlinkSync(deep, path.join(atBound, "f", "deep"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([shallow]);
  });

  it("follows a nested symlink chain into the tree the second hop points at", () => {
    // The layout that broke skills: ~/.claude/skills -> dotfiles/config/claude/skills,
    // whose entries link on again into dotfiles/agents/skills/<name>.
    const managedSkills = path.join(dotfiles, "config", "claude", "skills");
    const realSkill = path.join(dotfiles, "agents", "skills", "cb-babysit");
    mkdirSync(managedSkills, { recursive: true });
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(path.join(realSkill, "SKILL.md"), "# skill");
    symlinkSync(realSkill, path.join(managedSkills, "cb-babysit"));
    link("skills", managedSkills);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    // Granting only managedSkills is the partial failure: the agent can list the
    // directory and see every skill name, but reading SKILL.md returns EPERM.
    expect(actual).toContain(managedSkills);
    expect(actual).toContain(realSkill);
  });

  it("grants the file a chain ends at, not the directory holding the last link", () => {
    const realSettings = path.join(dotfiles, "real", "settings.json");
    const hop = path.join(dotfiles, "config", "claude");
    mkdirSync(path.dirname(realSettings), { recursive: true });
    mkdirSync(hop, { recursive: true });
    writeFileSync(realSettings, "{}");
    symlinkSync(realSettings, path.join(hop, "settings.json"));
    link("settings.json", path.join(hop, "settings.json"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([realSettings]);
    expect(actual).not.toContain(hop);
  });

  it("terminates on a symlink cycle", () => {
    const loop = path.join(dotfiles, "loop");
    mkdirSync(loop);
    symlinkSync(loop, path.join(loop, "self"));
    link("skills", loop);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([loop]);
  });

  it("refuses a chain that resolves to $HOME without walking it", () => {
    const hop = path.join(dotfiles, "hop");
    mkdirSync(hop);
    symlinkSync(fakeHome, path.join(hop, "home"));
    link("skills", hop);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([hop]);
    const [message] = assertDefined(writeErrorMock.mock.calls.at(0));
    expect(message).toContain(fakeHome);
  });

  it("does not crawl runtime state directories under the agent config dir", () => {
    const transcript = path.join(dotfiles, "transcript.jsonl");
    writeFileSync(transcript, "{}");
    mkdirSync(path.join(configDir, "projects", "some-repo"), { recursive: true });
    symlinkSync(transcript, path.join(configDir, "projects", "some-repo", "session.jsonl"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
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
    mkdirSync(path.join(fakeHome, ".config"), { recursive: true });
    symlinkSync(path.join(dotfiles, "missing-gh"), path.join(fakeHome, ".config", "gh"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("grants the dotfiles target behind a symlinked ~/.gitconfig", () => {
    const gitConfig = path.join(dotfiles, "gitconfig");
    const home = path.join(fakeHome, ".gitconfig");
    writeFileSync(gitConfig, "[user]\n");
    symlinkSync(gitConfig, home);
    seedGitConfigOrigins(home);

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

  it("grants every file git loads, including an include.path target", () => {
    // ~/.gitconfig is a real file; its indirection is a git directive, not a
    // symlink, so nothing in the walk can find the file it pulls in.
    const managed = path.join(dotfiles, "gitconfig");
    const home = path.join(fakeHome, ".gitconfig");
    writeFileSync(managed, "[user]\n");
    writeFileSync(home, "[include]\n");
    seedGitConfigOrigins(home, managed);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([home, managed]);
  });

  it("refuses repository-local git config origins", () => {
    // .git/config is writable by the sandboxed agent and by repo hooks, so an
    // include.path there must not be able to widen the next launch's sandbox.
    const secret = path.join(dotfiles, "credentials");
    writeFileSync(secret, "[default]\n");
    seedGitConfigScopes({ scope: "local", file: secret }, { scope: "worktree", file: secret });

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("grants a system-scope origin alongside global ones", () => {
    const system = path.join(dotfiles, "system-gitconfig");
    writeFileSync(system, "[core]\n");
    seedGitConfigScopes({ scope: "system", file: system });

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([system]);
  });

  it("ignores git config origins that are not files", () => {
    runCommandMock.mockReturnValue("global\0command line:\0user.name");

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("survives a git that cannot report its config", () => {
    runCommandMock.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("drops a git config origin that no longer exists", () => {
    seedGitConfigOrigins(path.join(dotfiles, "deleted-gitconfig"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("refuses a git config origin that resolves to $HOME", () => {
    seedGitConfigOrigins(fakeHome);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
    const [message] = assertDefined(writeErrorMock.mock.calls.at(0));
    expect(message).toContain("local.readOnlyDirs");
  });

  it("refuses a link resolving to the directory holding every home", () => {
    link("settings.json", path.dirname(fakeHome));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("drops a target already covered by a granted directory", () => {
    const tree = path.join(dotfiles, "tree");
    const inner = path.join(tree, "inner", "settings.json");
    mkdirSync(path.dirname(inner), { recursive: true });
    writeFileSync(inner, "{}");
    link("skills", tree);
    link("settings.json", inner);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([tree]);
  });

  it("does not descend into cached copies of other repositories", () => {
    const cached = path.join(dotfiles, "cached-plugin");
    mkdirSync(cached);
    mkdirSync(path.join(configDir, "plugins", "cache", "some-plugin"), { recursive: true });
    symlinkSync(cached, path.join(configDir, "plugins", "cache", "some-plugin", "link"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("logs one visible line naming how many paths were auto-granted", () => {
    const settings = path.join(dotfiles, "settings.json");
    writeFileSync(settings, "{}");
    link("settings.json", settings);

    resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("Auto-granted 1 read-only"));
  });

  it("stays silent when there is nothing to grant", () => {
    resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(logMock).not.toHaveBeenCalled();
  });

  it("stops at the grant cap and says so", () => {
    const targets = Array.from({ length: 260 }, (_, index) => {
      const target = path.join(dotfiles, `target-${index}`);
      mkdirSync(target);
      symlinkSync(target, path.join(configDir, `link-${index}`));
      return target;
    });

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toHaveLength(256);
    expect(targets).toHaveLength(260);
    const [message] = assertDefined(writeErrorMock.mock.calls.at(0));
    expect(message).toContain("local.readOnlyDirs");
  });

  it("refuses a link into a credential store", () => {
    const credentials = path.join(fakeHome, ".aws", "credentials");
    mkdirSync(path.dirname(credentials), { recursive: true });
    writeFileSync(credentials, "[default]\n");
    link("settings.json", credentials);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
    const [message] = assertDefined(writeErrorMock.mock.calls.at(0));
    expect(message).toContain("credential store");
  });

  it("refuses the credential store directory itself", () => {
    mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
    link("skills", path.join(fakeHome, ".ssh"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
  });

  it("refuses a target holding safehouse's grant-list delimiter", () => {
    const target = path.join(dotfiles, "with:colon");
    mkdirSync(target);
    link("skills", target);

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(actual).toEqual([]);
    const [message] = assertDefined(writeErrorMock.mock.calls.at(0));
    expect(message).toContain("splitting into two");
  });

  it("resolves pi's config directory", () => {
    const managed = path.join(dotfiles, "pi-agent");
    mkdirSync(managed);
    mkdirSync(path.join(fakeHome, ".pi"), { recursive: true });
    symlinkSync(managed, path.join(fakeHome, ".pi", "agent"));

    const actual = resolveSandboxSymlinkGrants({ agent: "pi", homeDir: fakeHome });

    expect(actual).toEqual([managed]);
  });

  it("skips a target an explicit readOnlyDirs entry already covers", () => {
    const target = path.join(dotfiles, "config", "claude");
    mkdirSync(target, { recursive: true });
    link("skills", target);

    const actual = resolveSandboxSymlinkGrants({
      agent: "claude",
      homeDir: fakeHome,
      explicitDirs: [dotfiles],
    });

    expect(actual).toEqual([]);
  });

  it("frees cap slots when a later grant subsumes earlier ones", () => {
    // The parent tree is linked last, so its children are granted first; those
    // slots must come back rather than counting toward the cap.
    const tree = path.join(dotfiles, "tree");
    const children = Array.from({ length: 3 }, (_, index) => {
      const child = path.join(tree, `child-${index}`);
      mkdirSync(child, { recursive: true });
      symlinkSync(child, path.join(configDir, `a-child-${index}`));
      return child;
    });
    symlinkSync(tree, path.join(configDir, "z-tree"));

    const actual = resolveSandboxSymlinkGrants({ agent: "claude", homeDir: fakeHome });

    expect(children).toHaveLength(3);
    expect(actual).toEqual([tree]);
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
