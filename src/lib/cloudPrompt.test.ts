import { describe, expect, it } from "vitest";

import {
  CLOUD_PROMPT_PLACEHOLDERS,
  DEFAULT_CLOUD_PROMPT_INITIAL,
  renderCloudPrompt,
} from "./cloudPrompt.ts";

const PLACEHOLDER_RE = /{{[^{}]*}}/g;

function renderDefaultPrompt(): string {
  return renderCloudPrompt(DEFAULT_CLOUD_PROMPT_INITIAL, {
    task: "TG-1",
    title: "T",
    description: "D",
    branch: "dev-tg-1",
  });
}

describe("renderCloudPrompt", () => {
  it("renders task, title, description and branch placeholders", () => {
    expect(
      renderCloudPrompt("{{task}}|{{title}}|{{description}}|{{branch}}", {
        task: "TG-1",
        title: "T",
        description: "D",
        branch: "dev-tg-1",
      }),
    ).toBe("TG-1|T|D|dev-tg-1");
  });
});

describe("DEFAULT_CLOUD_PROMPT_INITIAL", () => {
  it("tells the agent to open the PR through the GitHub API with the task branch as head", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).toContain("gh api repos/{owner}/{repo}/pulls");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("head `dev-tg-1`");
    expect(prompt).toContain("Closes TG-1");
  });

  it("names the task branch explicitly for checkout, commit and push", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).toContain("git fetch origin dev-tg-1 && git checkout dev-tg-1");
    expect(prompt).toContain("Commit only to `dev-tg-1`");
    expect(prompt).toContain("push only to `dev-tg-1`");
    expect(prompt).toContain("Never create or push any other branch");
    expect(prompt).toContain("exactly what the error was");
  });

  it("prepares the pinned toolchain and dependencies before committing or opening the PR", () => {
    const prompt = renderDefaultPrompt();
    const setupIndex = prompt.indexOf("mise install");

    expect(setupIndex).toBeGreaterThan(-1);
    expect(prompt).toContain("node -v");
    expect(prompt).toContain("npm ci");
    expect(prompt).toContain("exact error");
    expect(setupIndex).toBeLessThan(prompt.indexOf("Commit only to"));
    expect(setupIndex).toBeLessThan(prompt.indexOf("Open the PR"));
  });

  it("drops local-only wording", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).not.toMatch(/GROUNDCREW_/);
    expect(prompt).not.toMatch(/worktree/i);
    expect(prompt).not.toMatch(/stack/i);
    expect(prompt).not.toMatch(/crew task done/);
  });

  it("asks the agent to watch the PR and push fixes to the task branch", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).not.toContain("cloned on");
    expect(prompt).toContain("CI failures");
    expect(prompt).toContain("review comments");
    expect(prompt).toContain("pushing new commits to `dev-tg-1`");
  });

  it("only uses allowed placeholders", () => {
    const usedPlaceholders = DEFAULT_CLOUD_PROMPT_INITIAL.match(PLACEHOLDER_RE) ?? [];

    expect(usedPlaceholders.length).toBeGreaterThan(0);
    for (const placeholder of usedPlaceholders) {
      expect(CLOUD_PROMPT_PLACEHOLDERS.has(placeholder)).toBe(true);
    }
  });
});
