import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { stageSrtSettings } from "./stagedLaunch.ts";

describe(stageSrtSettings, () => {
  it("writes the settings JSON to a dedicated temp dir and returns its paths", () => {
    const settings: SandboxRuntimeConfig = {
      network: { allowedDomains: ["api.anthropic.com"], deniedDomains: [] },
      filesystem: {
        denyRead: ["/home"],
        allowRead: ["/work"],
        allowWrite: ["/work"],
        denyWrite: [],
      },
      allowPty: true,
    };

    const staged = stageSrtSettings("team-1", settings);

    try {
      expect(staged.file).toBe(path.join(staged.directory, "settings.json"));
      expect(path.basename(staged.directory)).toMatch(/^groundcrew-srt-team-1-/);
      expect(JSON.parse(readFileSync(staged.file, "utf8"))).toStrictEqual(settings);
    } finally {
      rmSync(staged.directory, { recursive: true, force: true });
    }
  });
});
