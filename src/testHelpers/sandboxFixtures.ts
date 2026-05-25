import type { RunCommandOptions } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";

export type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

export type SbxCall = Parameters<RunCommandMock>;

interface MockRunCommand {
  mock: { calls: SbxCall[] };
  mockImplementation: (impl: RunCommandMock) => void;
}

export function makeSandboxConfig(): ResolvedConfig {
  return {
    linear: {
      projects: [
        {
          projectSlug: "x-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
    },
    sources: [],
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
        claude: {
          cmd: "claude --auto",
          color: "#fff",
          sandbox: { agent: "claude", template: "node-22", kits: ["npm-cache"] },
        },
        codex: {
          cmd: "codex --auto",
          color: "#0ff",
          sandbox: { agent: "codex" },
        },
        cursor: {
          cmd: "cursor-agent",
          color: "#929292",
          sandbox: { agent: "cursor" },
        },
        unsandboxed: {
          cmd: "agent --noop",
          color: "#abc",
        },
      },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: "/tmp/groundcrew-sandbox-test.log" },
  };
}

function isSbxCall(call: SbxCall, verb: string): boolean {
  return call[0] === "sbx" && call[1][0] === verb;
}

export function findSbxCall(mock: MockRunCommand, verb: string): SbxCall | undefined {
  return mock.mock.calls.find((call) => isSbxCall(call, verb));
}

export function sbxCallsForVerb(
  mock: MockRunCommand,
  verb: string,
): readonly (readonly string[])[] {
  return mock.mock.calls.filter((call) => isSbxCall(call, verb)).map((call) => call[1]);
}

export function mockSbxLs(mock: MockRunCommand, rows: readonly string[]): void {
  const header = "NAME STATUS";
  const body = rows.map((row) => `${row} running`).join("\n");
  mock.mockImplementation(async (command, arguments_) => {
    if (command === "sbx" && arguments_[0] === "ls") {
      return `${header}\n${body}\n`;
    }
    return "";
  });
}
