import { loadConfig } from "../../lib/config.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "../../testHelpers/consoleCapture.ts";
import { makeSandboxConfig } from "../../testHelpers/sandboxFixtures.ts";
import { sandboxCli } from "./index.ts";

vi.mock(import("../../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});

const loadConfigMock = vi.mocked(loadConfig);

describe(sandboxCli, () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    loadConfigMock.mockResolvedValue(makeSandboxConfig());
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    vi.resetAllMocks();
  });

  it("prints usage and throws when no sub-verb is provided", async () => {
    await expect(sandboxCli([])).rejects.toThrow(/Usage: crew sandbox/);
  });

  it("rejects an unknown sub-verb", async () => {
    await expect(sandboxCli(["bogus"])).rejects.toThrow(/Unknown sandbox sub-verb: bogus/);
  });
});
