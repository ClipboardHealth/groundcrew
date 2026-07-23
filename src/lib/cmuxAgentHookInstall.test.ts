import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { installCmuxAgentHooks } from "./cmuxAgentHookInstall.ts";

const runCommandMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[], options?: unknown) => string>(),
);
const logEventMock = vi.hoisted(() =>
  vi.fn<(event: string, fields: Record<string, unknown>) => void>(),
);
const writeErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
  };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logEvent: logEventMock,
    writeError: writeErrorMock,
  };
});

describe(installCmuxAgentHooks, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("runs `cmux hooks codex install --yes` with CODEX_HOME set to the relocated config dir", () => {
    installCmuxAgentHooks({ agent: "codex", configDir: "/tmp/gc-codex-home" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      ["hooks", "codex", "install", "--yes"],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: "/tmp/gc-codex-home" }),
      }),
    );
  });

  it("logs outcome=installed on a successful install", () => {
    runCommandMock.mockReturnValue("");

    installCmuxAgentHooks({ agent: "codex", configDir: "/tmp/gc-codex-home" });

    expect(logEventMock).toHaveBeenCalledWith(
      "cmux-agent-hooks-install",
      expect.objectContaining({ agent: "codex", outcome: "installed" }),
    );
  });

  it("gives cmux-owned hooks a writable Foundation cache home without changing other hooks", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "cmux-hook-install-"));
    const hooksPath = path.join(configDir, "hooks.json");
    const cmuxCommand = `cmux_cli="\${CMUX_BUNDLED_CLI_PATH:-}"; "$cmux_cli" hooks feed --source codex --event PreToolUse`;
    const userCommand = "./scripts/user-hook.sh";
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: cmuxCommand },
                { type: "command", command: userCommand },
                { type: "prompt", prompt: "Review this tool call" },
              ],
            },
          ],
        },
      }),
    );

    try {
      installCmuxAgentHooks({ agent: "codex", configDir });

      const installedHooks = readFileSync(hooksPath, "utf8");
      expect(installedHooks).toContain(`export CFFIXED_USER_HOME='${configDir}'`);
      expect(installedHooks).toContain("export CMUX_CLI_SENTRY_DISABLED=1");
      expect(JSON.parse(installedHooks)).toMatchObject({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { command: expect.stringContaining(cmuxCommand) },
                { command: userCommand },
                { type: "prompt", prompt: "Review this tool call" },
              ],
            },
          ],
        },
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate the Safehouse compatibility prefix", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "cmux-hook-install-"));
    const hooksPath = path.join(configDir, "hooks.json");
    const prefix = `export CFFIXED_USER_HOME='${configDir}'; export CMUX_CLI_SENTRY_DISABLED=1; `;
    const cmuxCommand = `cmux_cli="\${CMUX_BUNDLED_CLI_PATH:-}"; "$cmux_cli" hooks codex stop`;
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `${prefix}${cmuxCommand}` }] }],
        },
      }),
    );

    try {
      installCmuxAgentHooks({ agent: "codex", configDir });

      const installedHooks = readFileSync(hooksPath, "utf8");
      expect(installedHooks.match(/CFFIXED_USER_HOME/g)).toHaveLength(1);
      expect(installedHooks.match(/CMUX_CLI_SENTRY_DISABLED/g)).toHaveLength(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("swallows a failing install (non-zero exit / missing cmux CLI) and logs outcome=error", () => {
    runCommandMock.mockImplementation(() => {
      throw new Error("spawn cmux ENOENT");
    });

    expect(() => {
      installCmuxAgentHooks({ agent: "codex", configDir: "/tmp/gc-codex-home" });
    }).not.toThrow();
    expect(logEventMock).toHaveBeenCalledWith(
      "cmux-agent-hooks-install",
      expect.objectContaining({
        agent: "codex",
        outcome: "error",
        errorMessage: expect.stringContaining("ENOENT"),
      }),
    );
    expect(writeErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/cmux hooks.*codex.*ENOENT/i),
    );
  });

  it("skips the install and logs outcome=skipped for an agent with no registered config relocation", () => {
    installCmuxAgentHooks({ agent: "claude", configDir: "/tmp/gc-claude-home" });

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(logEventMock).toHaveBeenCalledWith(
      "cmux-agent-hooks-install",
      expect.objectContaining({ agent: "claude", outcome: "skipped" }),
    );
  });
});
