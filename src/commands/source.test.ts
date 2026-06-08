/* eslint-disable no-template-curly-in-string -- ${id}-style placeholders are intentional shell substitution literals, not JS template expressions */

import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import type { TaskSource } from "../lib/taskSource.ts";
import { captureConsoleLog } from "../testHelpers/consoleCapture.ts";

import { sourceCli } from "./source.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: vi.fn<typeof loadConfig>(),
  };
});

vi.mock(import("../lib/buildSources.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildSources: vi.fn<typeof buildSources>(),
    sourcesFromConfig: vi.fn<typeof sourcesFromConfig>(),
  };
});

const loadConfigMock = vi.mocked(loadConfig);
const buildSourcesMock = vi.mocked(buildSources);
const sourcesFromConfigMock = vi.mocked(sourcesFromConfig);

function makeConfig(): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: {
        claude: { cmd: "safehouse claude --permission-mode auto", color: "#fff" },
      },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function stubSource(name: string): TaskSource {
  return {
    name,
    verify: vi.fn<TaskSource["verify"]>(),
    fetch: vi.fn<TaskSource["fetch"]>(),
    resolveOne: vi.fn<TaskSource["resolveOne"]>(),
    markInProgress: vi.fn<TaskSource["markInProgress"]>(),
    markInReview: vi.fn<TaskSource["markInReview"]>(),
  };
}

const LINEAR_RAW = { kind: "linear" };
const SHELL_RAW_MINIMAL = { kind: "shell", name: "jira", commands: { fetch: "./fetch.sh" } };
const SHELL_RAW_FULL = {
  kind: "shell",
  name: "jira",
  commands: {
    verify: "jira me",
    fetch: "./fetch.sh",
    resolveOne: "./resolve.sh ${id}",
    markInProgress: "jira move ${id} 'In Progress'",
    markInReview: "jira move ${id} 'In Review'",
    markDone: "jira move ${id} 'Done'",
  },
};

describe("sourceCli dispatch", () => {
  it("throws with usage for an unknown subcommand", async () => {
    await expect(sourceCli(["unknown"])).rejects.toThrow("crew source");
  });

  it("throws with usage when no subcommand given", async () => {
    await expect(sourceCli([])).rejects.toThrow("crew source");
  });
});

describe("crew source list", () => {
  beforeEach(() => {
    loadConfigMock.mockResolvedValue(makeConfig());
  });

  it("prints table with a linear source", async () => {
    sourcesFromConfigMock.mockReturnValue([LINEAR_RAW]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain("NAME");
    expect(output).toContain("KIND");
    expect(output).toContain("WRITEBACK");
    expect(output).toContain("linear");
  });

  it("shows linear capabilities correctly", async () => {
    sourcesFromConfigMock.mockReturnValue([LINEAR_RAW]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list"]);
    } finally {
      log.restore();
    }

    const lines = log.output().split("\n");
    // first line is the header, second is the data row
    const [, linearRow] = lines;
    expect(linearRow).toContain("yes");
    expect(linearRow).toContain("no"); // createTask = false
  });

  it("shows minimal shell source with no verify, writeback = no", async () => {
    sourcesFromConfigMock.mockReturnValue([SHELL_RAW_MINIMAL]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list"]);
    } finally {
      log.restore();
    }

    const lines = log.output().split("\n");
    const [, dataRow] = lines;
    // no verify, no writeback commands
    expect(dataRow).toMatch(/no\s+yes\s+yes\s+no\s+no/);
  });

  it("shows full shell source with verify and all writeback commands", async () => {
    sourcesFromConfigMock.mockReturnValue([SHELL_RAW_FULL]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list"]);
    } finally {
      log.restore();
    }

    const lines = log.output().split("\n");
    const [, dataRow] = lines;
    // verify=yes, writeback=yes (has markInProgress, markInReview, markDone)
    expect(dataRow).toMatch(/yes\s+yes\s+yes\s+no\s+yes/);
  });

  it("outputs JSON with --json flag", async () => {
    sourcesFromConfigMock.mockReturnValue([LINEAR_RAW]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list", "--json"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain('"name": "linear"');
    expect(output).toContain('"kind": "linear"');
    expect(output).toContain('"verify": true');
    expect(output).toContain('"listTasks": true');
    expect(output).toContain('"createTask": false');
    expect(output).toContain('"markDone": false');
  });

  it("shows an unknown adapter kind with fallback capabilities (listTasks only)", async () => {
    sourcesFromConfigMock.mockReturnValue([{ kind: "custom-plugin", name: "my-plugin" }]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list"]);
    } finally {
      log.restore();
    }

    const lines = log.output().split("\n");
    const [, dataRow] = lines;
    expect(dataRow).toContain("my-plugin");
    // unknown kind: verify=no, listTasks=yes, getTask=no, create=no, writeback=no
    expect(dataRow).toMatch(/no\s+yes\s+no\s+no\s+no/);
  });

  it("shows (no sources configured) when sourcesFromConfig returns empty array", async () => {
    sourcesFromConfigMock.mockReturnValue([]);
    const log = captureConsoleLog();
    try {
      await sourceCli(["list"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("no sources");
  });

  it("throws on unknown argument", async () => {
    sourcesFromConfigMock.mockReturnValue([LINEAR_RAW]);
    await expect(sourceCli(["list", "--foo"])).rejects.toThrow("unknown argument: --foo");
  });
});

describe("crew source verify", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    loadConfigMock.mockResolvedValue(makeConfig());
    sourcesFromConfigMock.mockReturnValue([LINEAR_RAW]);
  });

  it("verifies all sources and shows ok", async () => {
    const source = stubSource("linear");
    buildSourcesMock.mockResolvedValue([source]);

    const log = captureConsoleLog();
    try {
      await sourceCli(["verify"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("linear");
    expect(log.output()).toContain("ok");
    expect(process.exitCode).not.toBe(1);
  });

  it("shows failed and sets exit code 1 when verify throws", async () => {
    const source = stubSource("linear");
    vi.mocked(source.verify).mockRejectedValue(new Error("Missing LINEAR_API_KEY"));
    buildSourcesMock.mockResolvedValue([source]);

    const log = captureConsoleLog();
    try {
      await sourceCli(["verify"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("failed");
    expect(log.output()).toContain("Missing LINEAR_API_KEY");
    expect(process.exitCode).toBe(1);
  });

  it("verifies a specific source by name", async () => {
    const linear = stubSource("linear");
    const jira = stubSource("jira");
    buildSourcesMock.mockResolvedValue([linear, jira]);

    const log = captureConsoleLog();
    try {
      await sourceCli(["verify", "jira"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("jira");
    expect(log.output()).not.toContain("linear");
    expect(vi.mocked(linear.verify)).not.toHaveBeenCalledWith();
    expect(vi.mocked(jira.verify)).toHaveBeenCalledWith();
  });

  it("throws when the named source is not found", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("linear")]);
    await expect(sourceCli(["verify", "nonexistent"])).rejects.toThrow(
      'no source named "nonexistent"',
    );
  });

  it("outputs JSON with --json flag", async () => {
    const source = stubSource("linear");
    buildSourcesMock.mockResolvedValue([source]);

    const log = captureConsoleLog();
    try {
      await sourceCli(["verify", "--json"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain('"source": "linear"');
    expect(output).toContain('"ok": true');
  });

  it("outputs JSON with ok:false and message on failure", async () => {
    const source = stubSource("linear");
    vi.mocked(source.verify).mockRejectedValue(new Error("bad token"));
    buildSourcesMock.mockResolvedValue([source]);

    const log = captureConsoleLog();
    try {
      await sourceCli(["verify", "--json"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain('"ok": false');
    expect(output).toContain('"message": "bad token"');
  });

  it("throws on unknown option", async () => {
    buildSourcesMock.mockResolvedValue([]);
    await expect(sourceCli(["verify", "--foo"])).rejects.toThrow("unknown option: --foo");
  });

  it("throws on too many arguments", async () => {
    buildSourcesMock.mockResolvedValue([]);
    await expect(sourceCli(["verify", "linear", "extra"])).rejects.toThrow("too many arguments");
  });
});
