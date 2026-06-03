import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { stageSrtSettings } from "./stagedLaunch.ts";

describe(stageSrtSettings, () => {
  it("writes distinct prepare and agent settings JSON to a dedicated temp dir", () => {
    const prepare: SandboxRuntimeConfig = {
      network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [] },
      filesystem: {
        denyRead: ["/home"],
        allowRead: ["/work"],
        allowWrite: ["/work"],
        denyWrite: [],
      },
      allowPty: true,
    };
    const agent: SandboxRuntimeConfig = {
      network: { allowedDomains: ["api.anthropic.com"], deniedDomains: [] },
      filesystem: {
        denyRead: ["/home"],
        allowRead: ["/work", "/home/dev/.claude"],
        allowWrite: ["/work", "/home/dev/.claude"],
        denyWrite: ["/home/dev/.claude/settings.json"],
      },
      allowPty: true,
    };

    const staged = stageSrtSettings("team-1", { prepare, agent });

    try {
      expect(staged.prepareFile).toBe(path.join(staged.directory, "prepare-settings.json"));
      expect(staged.agentFile).toBe(path.join(staged.directory, "agent-settings.json"));
      expect(path.basename(staged.directory)).toMatch(/^groundcrew-srt-team-1-/);
      expect(JSON.parse(readFileSync(staged.prepareFile, "utf8"))).toStrictEqual(prepare);
      expect(JSON.parse(readFileSync(staged.agentFile, "utf8"))).toStrictEqual(agent);
    } finally {
      rmSync(staged.directory, { recursive: true, force: true });
    }
  });
});
