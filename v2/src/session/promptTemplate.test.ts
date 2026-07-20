import { describe, expect, it } from "vitest";

import { CREW_DONE_INSTRUCTION } from "./profiles.js";
import { DEFAULT_PROMPT_TEMPLATE, renderPromptTemplate } from "./promptTemplate.js";

describe("renderPromptTemplate", () => {
  it("substitutes every known placeholder", () => {
    const rendered = renderPromptTemplate({
      template: "task {{id}} ({{title}}): {{description}} repos={{repos}}",
      variables: {
        id: "fixture:TASK-1",
        title: "Fix the bug",
        description: "The widget crashes.",
        repos: ["alpha", "beta"],
      },
    });

    expect(rendered).toBe("task fixture:TASK-1 (Fix the bug): The widget crashes. repos=alpha, beta");
  });

  it("renders empty for missing values", () => {
    const rendered = renderPromptTemplate({
      template: "[{{title}}][{{description}}][{{repos}}]",
      variables: { id: "fixture:TASK-1" },
    });

    expect(rendered).toBe("[][][]");
  });

  it("leaves unknown placeholders untouched", () => {
    const rendered = renderPromptTemplate({
      template: "{{id}} {{unknown}}",
      variables: { id: "fixture:TASK-1" },
    });

    expect(rendered).toBe("fixture:TASK-1 {{unknown}}");
  });

  it("preserves multi-line, quote, and backtick content in the description", () => {
    const description = "line one\nline `two` with 'quotes' and \"doubles\"";
    const rendered = renderPromptTemplate({
      template: "{{description}}",
      variables: { id: "x", description },
    });

    expect(rendered).toBe(description);
  });

  describe("DEFAULT_PROMPT_TEMPLATE", () => {
    it("carries the title, description, and repos into the rendered prompt", () => {
      const rendered = renderPromptTemplate({
        template: DEFAULT_PROMPT_TEMPLATE,
        variables: {
          id: "fixture:TASK-1",
          title: "Fix the widget",
          description: "It crashes on load.",
          repos: ["alpha"],
        },
      });

      expect(rendered).toContain("fixture:TASK-1");
      expect(rendered).toContain("Fix the widget");
      expect(rendered).toContain("It crashes on load.");
      expect(rendered).toContain("alpha");
    });

    it("closes with the crew-done instruction", () => {
      const rendered = renderPromptTemplate({
        template: DEFAULT_PROMPT_TEMPLATE,
        variables: { id: "fixture:TASK-1", title: "t" },
      });

      expect(rendered.endsWith(CREW_DONE_INSTRUCTION)).toBe(true);
    });
  });
});
