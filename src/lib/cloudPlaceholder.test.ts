import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCloudPlaceholderCommand } from "./cloudPlaceholder.ts";

const input = {
  task: "team-1",
  title: "It's a title",
  sessionUrl: "https://claude.ai/code/session_1",
  crewEntrypoint: ["/opt/my node/bin/node", "/opt/crew/cli.js"],
};

describe(buildCloudPlaceholderCommand, () => {
  it("prints the task, title, session url and the cloud notice", () => {
    const result = spawnSync("sh", ["-c", buildCloudPlaceholderCommand(input)], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], SHELL: "/usr/bin/true" },
    });

    expect(result.stdout).toBe(
      [
        "Task: team-1",
        "Title: It's a title",
        "Session: https://claude.ai/code/session_1",
        "This run is in the cloud.",
        "",
        "Take it over locally with:",
        "  '/opt/my node/bin/node' '/opt/crew/cli.js' 'resume' 'team-1'",
        "",
      ].join("\n"),
    );
  });

  it("starts by clearing the screen without aborting when clear is missing", () => {
    expect(buildCloudPlaceholderCommand(input)).toMatch(/^clear 2>\/dev\/null \|\| true; printf /);
  });

  it("keeps the pane open by exec-ing the user's shell", () => {
    expect(buildCloudPlaceholderCommand(input)).toMatch(/; exec "\$\{SHELL:-\/bin\/sh\}"$/);
  });

  it("reports cmux progress only when a workspace id is present", () => {
    const command = buildCloudPlaceholderCommand(input);

    expect(command).toContain(
      `if [ -n "$CMUX_WORKSPACE_ID" ]; then "\${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress 0.5 --label 'running · cloud' --workspace "$CMUX_WORKSPACE_ID" >/dev/null 2>&1 || true; fi`,
    );
  });

  describe("with a stub cmux cli", () => {
    let directory: string;
    let callLog: string;
    let stubCli: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "cloud-placeholder-"));
      callLog = join(directory, "calls");
      stubCli = join(directory, "cmux");
      writeFileSync(stubCli, `#!/bin/sh\necho "$@" >> '${callLog}'\n`, { mode: 0o755 });
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    function runWith(workspaceId: string): void {
      spawnSync("sh", ["-c", buildCloudPlaceholderCommand(input)], {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"],
          SHELL: "/usr/bin/true",
          CMUX_BUNDLED_CLI_PATH: stubCli,
          CMUX_WORKSPACE_ID: workspaceId,
        },
      });
    }

    it("sets cloud progress against the workspace id when one is present", () => {
      runWith("ws-9");

      expect(readFileSync(callLog, "utf8")).toBe(
        "set-progress 0.5 --label running · cloud --workspace ws-9\n",
      );
    });

    it("does not call the cmux cli when the workspace id is empty", () => {
      runWith("");

      expect(existsSync(callLog)).toBe(false);
    });
  });

  it("quotes hostile values so they stay literal", () => {
    const hostile = { ...input, title: "$(touch /tmp/pwned); `x`" };
    const result = spawnSync("sh", ["-c", buildCloudPlaceholderCommand(hostile)], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], SHELL: "/usr/bin/true" },
    });

    expect(result.stdout).toContain("Title: $(touch /tmp/pwned); `x`");
  });
});
