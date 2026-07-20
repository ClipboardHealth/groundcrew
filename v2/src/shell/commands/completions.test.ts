import { describe, expect, it } from "vitest";

import { CliError } from "../errors.js";
import { createCaptureIo } from "../io.js";
import { runCompletions } from "./completions.js";

describe("runCompletions", () => {
  it("prints a completion script for each supported shell", () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const io = createCaptureIo();
      runCompletions({ shell, io });
      expect(io.stdout.join("\n")).toContain("crew");
    }
  });

  it("rejects an unsupported shell", () => {
    const io = createCaptureIo();
    expect(() => {
      runCompletions({ shell: "powershell", io });
    }).toThrow(CliError);
  });
});
