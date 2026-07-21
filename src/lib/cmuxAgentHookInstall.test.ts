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
