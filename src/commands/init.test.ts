import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { initConfig, initConfigCli } from "./init.ts";

const EXAMPLE_PATH = path.join(import.meta.dirname, "..", "..", "crew.config.example.ts");
const exampleContents = readFileSync(EXAMPLE_PATH, "utf8");

async function withCwd(directory: string, fn: () => Promise<void>): Promise<void> {
  const original = process.cwd();
  process.chdir(directory);
  try {
    await fn();
  } finally {
    process.chdir(original);
  }
}

describe("crew init", () => {
  let cwd: string;
  let xdgHome: string;
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "groundcrew-init-cwd-"));
    xdgHome = mkdtempSync(path.join(tmpdir(), "groundcrew-init-xdg-"));
    setEnvironmentVariable("XDG_CONFIG_HOME", xdgHome);
    consoleLog = captureConsoleLog();
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(xdgHome, { recursive: true, force: true });
    deleteEnvironmentVariable("XDG_CONFIG_HOME");
    process.exitCode = 0;
  });

  describe(initConfig, () => {
    it("writes the example to <cwd>/crew.config.ts by default", () => {
      const result = initConfig({ cwd });

      const destination = path.join(cwd, "crew.config.ts");
      expect(result.outcome).toBe("wrote");
      expect(result.destination).toBe(destination);
      expect(readFileSync(destination, "utf8")).toBe(exampleContents);
      expect(consoleLog.output()).toContain(`[wrote] ${destination}`);
    });

    it("writes to the XDG groundcrew dir when scope is global", () => {
      const result = initConfig({ scope: "global" });

      const destination = path.join(xdgHome, "groundcrew", "crew.config.ts");
      expect(result.outcome).toBe("wrote");
      expect(result.destination).toBe(destination);
      expect(readFileSync(destination, "utf8")).toBe(exampleContents);
    });

    it("creates the groundcrew parent directory under XDG when missing", () => {
      expect(existsSync(path.join(xdgHome, "groundcrew"))).toBe(false);

      initConfig({ scope: "global" });

      expect(existsSync(path.join(xdgHome, "groundcrew"))).toBe(true);
    });

    it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
      deleteEnvironmentVariable("XDG_CONFIG_HOME");

      // Dry-run keeps the test off the real home dir — we only need the
      // resolved destination path, not the side effect.
      const result = initConfig({ scope: "global", dryRun: true });

      expect(result.destination).toContain(path.join(".config", "groundcrew", "crew.config.ts"));
    });

    it("ignores a relative XDG_CONFIG_HOME per the XDG spec", () => {
      setEnvironmentVariable("XDG_CONFIG_HOME", "relative/path");

      const result = initConfig({ scope: "global", dryRun: true });

      expect(result.destination).toContain(path.join(".config", "groundcrew", "crew.config.ts"));
      expect(result.destination).not.toContain("relative/path");
    });

    it("refuses to overwrite an existing destination without --force", () => {
      const destination = path.join(cwd, "crew.config.ts");
      writeFileSync(destination, "existing content");

      const result = initConfig({ cwd });

      expect(result.outcome).toBe("exists");
      expect(readFileSync(destination, "utf8")).toBe("existing content");
      expect(consoleLog.output()).toContain(`[exists] ${destination}`);
      expect(consoleLog.output()).toContain("--force to overwrite");
    });

    it("overwrites an existing destination when --force is passed", () => {
      const destination = path.join(cwd, "crew.config.ts");
      writeFileSync(destination, "existing content");

      const result = initConfig({ cwd, force: true });

      expect(result.outcome).toBe("wrote");
      expect(readFileSync(destination, "utf8")).toBe(exampleContents);
    });

    it("reports the planned write without touching disk in --dry-run", () => {
      const destination = path.join(cwd, "crew.config.ts");

      const result = initConfig({ cwd, dryRun: true });

      expect(result.outcome).toBe("dry-run-would-write");
      expect(existsSync(destination)).toBe(false);
      expect(consoleLog.output()).toContain(`[dry-run] would write ${destination}`);
    });

    it("treats an existing destination as exists even in --dry-run without --force", () => {
      const destination = path.join(cwd, "crew.config.ts");
      writeFileSync(destination, "existing content");

      const result = initConfig({ cwd, dryRun: true });

      expect(result.outcome).toBe("exists");
      expect(readFileSync(destination, "utf8")).toBe("existing content");
    });

    it("reports the planned overwrite when --dry-run and --force combine", () => {
      const destination = path.join(cwd, "crew.config.ts");
      writeFileSync(destination, "existing content");

      const result = initConfig({ cwd, dryRun: true, force: true });

      expect(result.outcome).toBe("dry-run-would-write");
      expect(readFileSync(destination, "utf8")).toBe("existing content");
    });

    it("writes a customized config when quickstart fields are supplied", () => {
      const result = initConfig({
        cwd,
        projectDir: "~/dev",
        repositories: ["OWNER/REPO"],
        runner: "none",
        agent: "claude",
      });

      const destination = path.join(cwd, "crew.config.ts");
      const actual = readFileSync(destination, "utf8");
      expect(result.outcome).toBe("wrote");
      expect(actual).toContain('projectDir: "~/dev"');
      expect(actual).toContain('knownRepositories: ["OWNER/REPO"]');
      expect(actual).toContain('local: { runner: "none" }');
      expect(actual).toContain('default: "claude"');
      expect(actual).toContain("claude: {}");
      expect(actual).not.toContain("disabled: true");
    });

    it("fails loudly when a quickstart template anchor is missing", () => {
      const template = path.join(cwd, "crew.config.example.ts");
      writeFileSync(
        template,
        exampleContents.replace('projectDir: "~/dev/groundcrew"', 'projectDir: "~/elsewhere"'),
      );

      expect(() => initConfig({ cwd, projectDir: "~/dev", examplePath: template })).toThrow(
        /crew init --project-dir: template anchor not found/,
      );
      expect(existsSync(path.join(cwd, "crew.config.ts"))).toBe(false);
    });
  });

  describe(initConfigCli, () => {
    it("writes the config and prints next-step guidance with no flags", async () => {
      await withCwd(cwd, async () => {
        await initConfigCli([]);
      });

      expect(existsSync(path.join(cwd, "crew.config.ts"))).toBe(true);
      const output = consoleLog.output();
      expect(output).toContain("Next steps:");
      expect(output).toContain("crew doctor");
      expect(process.exitCode).toBe(0);
    });

    it("sets exit code 1 when destination exists and --force is absent", async () => {
      writeFileSync(path.join(cwd, "crew.config.ts"), "existing content");

      await withCwd(cwd, async () => {
        await initConfigCli([]);
      });

      expect(process.exitCode).toBe(1);
    });

    it("routes --global to the XDG path", async () => {
      await initConfigCli(["--global"]);

      expect(existsSync(path.join(xdgHome, "groundcrew", "crew.config.ts"))).toBe(true);
    });

    it("accepts quickstart flags and prints clone plus Linear guidance", async () => {
      await initConfigCli([
        "--global",
        "--project-dir",
        "~/dev",
        "--repo",
        "OWNER/REPO",
        "--runner",
        "none",
        "--agent",
        "claude",
      ]);

      const destination = path.join(xdgHome, "groundcrew", "crew.config.ts");
      const actual = readFileSync(destination, "utf8");
      const output = consoleLog.output();
      expect(actual).toContain('projectDir: "~/dev"');
      expect(actual).toContain('knownRepositories: ["OWNER/REPO"]');
      expect(actual).toContain('local: { runner: "none" }');
      expect(actual).toContain('default: "claude"');
      expect(actual).toContain("claude: {}");
      expect(actual).not.toContain("disabled: true");
      expect(output).toContain('PROJECT_DIR="$HOME/dev"');
      expect(output).toContain('mkdir -p "$PROJECT_DIR/OWNER"');
      expect(output).toContain('git clone git@github.com:OWNER/REPO.git "$PROJECT_DIR/OWNER/REPO"');
      expect(output).toContain('sources: [{ kind: "linear" }]');
      expect(output).toContain("crew doctor");
      expect(output).toContain("crew run --watch");
    });

    it("supports Codex-only quickstart config and shell-escapes a ~/ project dir", async () => {
      await initConfigCli([
        "--global",
        "--project-dir",
        "~/Dev $Box",
        "--repo",
        "OWNER/REPO",
        "--agent",
        "codex",
      ]);

      const destination = path.join(xdgHome, "groundcrew", "crew.config.ts");
      const actual = readFileSync(destination, "utf8");
      const output = consoleLog.output();
      expect(actual).toContain('default: "codex"');
      expect(actual).toContain("codex: {}");
      expect(actual).not.toContain("// codex: {}");
      expect(actual).not.toContain("disabled: true");
      expect(output).toContain(String.raw`PROJECT_DIR="$HOME/Dev \$Box"`);
    });

    it("prints clone guidance for a bare repo and shell-quotes an absolute project dir", async () => {
      await initConfigCli(["--global", "--project-dir", "/tmp/ground crew's", "--repo", "repo-a"]);

      const output = consoleLog.output();
      expect(output).toContain(String.raw`PROJECT_DIR='/tmp/ground crew'\''s'`);
      expect(output).toContain('mkdir -p "$PROJECT_DIR"');
      expect(output).toContain('git clone <REMOTE_URL_FOR_repo-a> "$PROJECT_DIR/repo-a"');
    });

    it("uses the example project dir in clone guidance when only repos are supplied", async () => {
      await initConfigCli(["--global", "--repo", "OWNER/REPO"]);

      expect(consoleLog.output()).toContain('PROJECT_DIR="$HOME/dev/groundcrew"');
    });

    it("prints a HOME-only assignment when project dir is ~", async () => {
      await initConfigCli(["--global", "--project-dir", "~", "--repo", "OWNER/REPO"]);

      expect(consoleLog.output()).toContain('PROJECT_DIR="$HOME"');
    });

    it("accepts an explicit --local flag (cwd default)", async () => {
      await withCwd(cwd, async () => {
        await initConfigCli(["--local"]);
      });

      expect(existsSync(path.join(cwd, "crew.config.ts"))).toBe(true);
    });

    it("overwrites an existing config when --force is in argv", async () => {
      const destination = path.join(cwd, "crew.config.ts");
      writeFileSync(destination, "existing content");

      await withCwd(cwd, async () => {
        await initConfigCli(["--force"]);
      });

      expect(readFileSync(destination, "utf8")).toBe(exampleContents);
    });

    it("rejects an unknown flag with a helpful usage line", async () => {
      await expect(initConfigCli(["--what"])).rejects.toThrow(
        /Unknown option: --what[\s\S]*Usage: crew init/,
      );
    });

    it("rejects --runner without a value", async () => {
      await expect(initConfigCli(["--runner"])).rejects.toThrow(/crew init --runner/);
    });

    it("rejects unsupported runner values", async () => {
      await expect(initConfigCli(["--runner", "unsafe"])).rejects.toThrow(
        /--runner must be one of/,
      );
    });

    it("rejects --agent without a value", async () => {
      await expect(initConfigCli(["--agent"])).rejects.toThrow(/crew init --agent/);
    });

    it("rejects unsupported agent values", async () => {
      await expect(initConfigCli(["--agent", "cursor"])).rejects.toThrow(
        /--agent must be one of claude, codex/,
      );
    });

    it("rejects --global and --local passed together", async () => {
      await expect(initConfigCli(["--global", "--local"])).rejects.toThrow(
        /--global and --local are mutually exclusive/,
      );
    });

    it("does not print next-step guidance in --dry-run", async () => {
      await withCwd(cwd, async () => {
        await initConfigCli(["--dry-run"]);
      });

      expect(consoleLog.output()).not.toContain("Next steps:");
    });
  });
});
