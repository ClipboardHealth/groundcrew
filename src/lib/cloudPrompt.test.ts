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
  });
}

describe("renderCloudPrompt", () => {
  it("renders task, title and description placeholders", () => {
    expect(
      renderCloudPrompt("{{task}}|{{title}}|{{description}}", {
        task: "TG-1",
        title: "T",
        description: "D",
      }),
    ).toBe("TG-1|T|D");
  });
});

describe("DEFAULT_CLOUD_PROMPT_INITIAL", () => {
  it("tells the agent to open the PR through the REST API", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).toContain("gh api repos/{owner}/{repo}/pulls");
    expect(prompt).toContain("Closes TG-1");
  });

  it("drops local-only wording", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).not.toMatch(/GROUNDCREW_/);
    expect(prompt).not.toMatch(/worktree/i);
    expect(prompt).not.toMatch(/stack/i);
    expect(prompt).not.toMatch(/crew task done/);
  });

  it("asks the agent to stay on the cloned branch and watch the PR", () => {
    const prompt = renderDefaultPrompt();

    expect(prompt).toContain("cloned on");
    expect(prompt).toContain("CI failures");
    expect(prompt).toContain("review comments");
  });

  it("only uses allowed placeholders", () => {
    const usedPlaceholders = DEFAULT_CLOUD_PROMPT_INITIAL.match(PLACEHOLDER_RE) ?? [];

    expect(usedPlaceholders.length).toBeGreaterThan(0);
    for (const placeholder of usedPlaceholders) {
      expect(CLOUD_PROMPT_PLACEHOLDERS.has(placeholder)).toBe(true);
    }
  });
});
