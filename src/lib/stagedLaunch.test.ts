import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BUILD_SECRET_NAMES } from "./config.ts";
import { stageBuildSecrets, stageBuildSecretsForLaunch } from "./stagedLaunch.ts";

let promptDir: string;

beforeEach(() => {
  promptDir = mkdtempSync(path.join(os.tmpdir(), "groundcrew-test-"));
  for (const name of BUILD_SECRET_NAMES) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(promptDir, { recursive: true, force: true });
});

describe(stageBuildSecrets, () => {
  it("returns undefined when no build secrets are set", () => {
    expect(stageBuildSecrets(promptDir)).toBeUndefined();
  });

  it("writes a secrets file and returns its path when secrets are present", () => {
    vi.stubEnv("NPM_TOKEN", "my-npm-token");

    const result = stageBuildSecrets(promptDir);
    const expected = path.join(promptDir, "secrets.env");

    expect(result).toBe(expected);
    expect(readFileSync(expected, "utf8")).toContain("NPM_TOKEN='my-npm-token'");
  });
});

describe(stageBuildSecretsForLaunch, () => {
  beforeEach(() => {
    vi.stubEnv("NPM_TOKEN", "my-npm-token");
  });

  it("skips staging when there is no preparation command and no agent build secret", () => {
    const result = stageBuildSecretsForLaunch({
      promptDir,
      hasPreparationCommand: false,
      agentBuildSecrets: [],
    });

    expect(result).toBeUndefined();
  });

  it("stages secrets for a preparation command", () => {
    const result = stageBuildSecretsForLaunch({
      promptDir,
      hasPreparationCommand: true,
      agentBuildSecrets: [],
    });

    expect(result).toBe(path.join(promptDir, "secrets.env"));
  });

  it("stages secrets for agent build secrets even without a preparation command", () => {
    const result = stageBuildSecretsForLaunch({
      promptDir,
      hasPreparationCommand: false,
      agentBuildSecrets: ["NPM_TOKEN"],
    });

    expect(result).toBe(path.join(promptDir, "secrets.env"));
  });
});
