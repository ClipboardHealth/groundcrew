import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunCommandOptions } from "./commandRunner.ts";
import { CLAUDE_CONFIG_ALLOWLIST, injectClaudeConfig } from "./sandboxClaudeInjection.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

describe(injectClaudeConfig, () => {
  let hostHome: string;

  beforeEach(() => {
    runCommandMock.mockReset();
    runCommandMock.mockReturnValue("");
    hostHome = mkdtempSync(join(tmpdir(), "groundcrew-injection-"));
  });

  afterEach(() => {
    rmSync(hostHome, { recursive: true, force: true });
  });

  function seedHostEntry(entry: string, kind: "file" | "dir"): void {
    const path = join(hostHome, ".claude", entry);
    if (kind === "dir") {
      mkdirSync(path, { recursive: true });
      return;
    }
    mkdirSync(join(hostHome, ".claude"), { recursive: true });
    writeFileSync(path, "stub");
  }

  it("returns without touching the sandbox when ~/.claude is missing on the host", async () => {
    await injectClaudeConfig({ sandboxName: "groundcrew-claude", hostHome });

    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("creates the sandbox .claude directory before copying entries", async () => {
    seedHostEntry("CLAUDE.md", "file");

    await injectClaudeConfig({ sandboxName: "groundcrew-claude", hostHome });

    const [firstCall] = runCommandMock.mock.calls;
    expect(firstCall?.[0]).toBe("sbx");
    expect(firstCall?.[1]).toStrictEqual([
      "exec",
      "groundcrew-claude",
      "mkdir",
      "-p",
      "/home/agent/.claude",
    ]);
  });

  it("removes then copies each present allowlist entry", async () => {
    seedHostEntry("CLAUDE.md", "file");
    seedHostEntry("skills", "dir");

    await injectClaudeConfig({ sandboxName: "groundcrew-claude", hostHome });

    const afterMkdir = runCommandMock.mock.calls.slice(1);
    expect(afterMkdir).toHaveLength(4);
    expect(afterMkdir[0]?.[1].slice(0, 4)).toStrictEqual([
      "exec",
      "groundcrew-claude",
      "rm",
      "-rf",
    ]);
    expect(afterMkdir[1]?.[1][0]).toBe("cp");
    expect(afterMkdir[2]?.[1].slice(0, 4)).toStrictEqual([
      "exec",
      "groundcrew-claude",
      "rm",
      "-rf",
    ]);
    expect(afterMkdir[3]?.[1][0]).toBe("cp");
  });

  it("skips entries that don't exist on the host", async () => {
    seedHostEntry("CLAUDE.md", "file");

    await injectClaudeConfig({ sandboxName: "groundcrew-claude", hostHome });

    const cpCalls = runCommandMock.mock.calls.filter((call) => call[1][0] === "cp");
    expect(cpCalls).toHaveLength(1);
    expect(cpCalls[0]?.[1][1]).toBe(join(hostHome, ".claude", "CLAUDE.md"));
    expect(cpCalls[0]?.[1][2]).toBe("groundcrew-claude:/home/agent/.claude/CLAUDE.md");
  });

  it("removes the in-sandbox path before copying so directories don't nest on re-sync", async () => {
    seedHostEntry("skills", "dir");

    await injectClaudeConfig({ sandboxName: "groundcrew-claude", hostHome });

    expect(runCommandMock.mock.calls[1]?.[1]).toStrictEqual([
      "exec",
      "groundcrew-claude",
      "rm",
      "-rf",
      "/home/agent/.claude/skills",
    ]);
  });

  it("honours a custom sandboxHome", async () => {
    seedHostEntry("CLAUDE.md", "file");

    await injectClaudeConfig({
      sandboxName: "groundcrew-claude",
      hostHome,
      sandboxHome: "/root",
    });

    const cpCall = runCommandMock.mock.calls.find((call) => call[1][0] === "cp");
    expect(cpCall?.[1][2]).toBe("groundcrew-claude:/root/.claude/CLAUDE.md");
  });

  it("passes the AbortSignal through to every sbx call", async () => {
    seedHostEntry("CLAUDE.md", "file");
    const controller = new AbortController();

    await injectClaudeConfig({ sandboxName: "groundcrew-claude", hostHome }, controller.signal);

    for (const call of runCommandMock.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });

  it("exports the documented allowlist set", () => {
    expect(CLAUDE_CONFIG_ALLOWLIST).toStrictEqual([
      "CLAUDE.md",
      "MEMORY.md",
      "skills",
      "commands",
      "agents",
      "memory",
    ]);
  });
});
