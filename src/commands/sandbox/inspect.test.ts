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

describe("crew sandbox list / template", () => {
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
    it("prints only groundcrew-prefixed sandboxes from sbx ls", async () => {
      mockSbxLs(runCommandMock, ["groundcrew-claude", "groundcrew-codex", "other-sandbox"]);

      await sandboxCli(["list"]);

      const output = consoleLog.output();
      expect(output).toContain("groundcrew-claude");
      expect(output).toContain("groundcrew-codex");
      expect(output).not.toContain("other-sandbox");
    });

    it("prints '(none)' when no groundcrew-owned sandbox is present", async () => {
      mockSbxLs(runCommandMock, ["unrelated"]);

      await sandboxCli(["list"]);

      expect(consoleLog.output()).toContain("(none)");
    });
  });

  describe("template show", () => {
    it("prints agent, template, kits, and resolved sandbox name per sandbox model", async () => {
      await sandboxCli(["template", "show"]);

      const output = consoleLog.output();
      expect(output).toContain("claude");
      expect(output).toContain("groundcrew-claude");
      expect(output).toContain("node-22");
      expect(output).toContain("npm-cache");
      expect(output).toContain("codex");
      expect(output).toContain("groundcrew-codex");
      expect(output).not.toContain("unsandboxed");
    });

    it("rejects template without a sub-verb", async () => {
      await expect(sandboxCli(["template"])).rejects.toThrow(/Usage: crew sandbox template show/);
    });

    it("reports '(no sandbox models configured)' when no model declares a sandbox", async () => {
      const bareConfig = makeSandboxConfig();
      bareConfig.models.definitions = { plain: { cmd: "agent --noop", color: "#abc" } };
      loadConfigMock.mockResolvedValue(bareConfig);

      await sandboxCli(["template", "show"]);

      expect(consoleLog.output()).toContain("(no sandbox models configured)");
    });
  });
});
