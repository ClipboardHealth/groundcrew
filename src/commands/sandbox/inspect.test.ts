import { loadConfig } from "../../lib/config.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "../../testHelpers/consoleCapture.ts";
import {
  makeSandboxConfig,
  mockSbxLs,
  type RunCommandMock,
} from "../../testHelpers/sandboxFixtures.ts";
import { sandboxCli } from "./index.ts";

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mock shares one recorder across runCommandAsync overloads.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

vi.mock(import("../../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});

const loadConfigMock = vi.mocked(loadConfig);

describe("crew sandbox list", () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    loadConfigMock.mockResolvedValue(makeSandboxConfig());
    mockSbxLs(runCommandMock, []);
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    vi.resetAllMocks();
  });

  describe("list", () => {
    it("prints groundcrew-owned sandboxes with the prefix stripped, hiding unrelated ones", async () => {
      mockSbxLs(runCommandMock, ["groundcrew-claude", "groundcrew-codex", "other-sandbox"]);

      await sandboxCli(["list"]);

      const lines = consoleLog
        .output()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toStrictEqual(["claude", "codex"]);
    });

    it("prints '(none)' when no groundcrew-owned sandbox is present", async () => {
      mockSbxLs(runCommandMock, ["unrelated"]);

      await sandboxCli(["list"]);

      expect(consoleLog.output()).toContain("(none)");
    });
  });

  it("reports 'template' as an unknown sub-verb (the command was removed)", async () => {
    await expect(sandboxCli(["template", "show"])).rejects.toThrow(
      /Unknown sandbox sub-verb: template/,
    );
  });
});
