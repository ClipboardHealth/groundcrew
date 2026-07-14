import { visibleCommandNames } from "../cli.ts";
import { captureConsoleLog } from "../testHelpers/consoleCapture.ts";

import {
  COMPLETION_SPEC,
  completionsCli,
  generateCompletionScript,
  SUPPORTED_SHELLS,
} from "./completions.ts";

describe("crew completions", () => {
  describe("completion spec", () => {
    it("covers exactly the visible top-level commands", () => {
      const expected = [...visibleCommandNames()].toSorted();

      const actual = COMPLETION_SPEC.map((command) => command.name).toSorted();

      expect(actual).toStrictEqual(expected);
    });
  });

  describe("script generation", () => {
    describe("bash", () => {
      const script = generateCompletionScript("bash");

      it("registers the completion function for crew", () => {
        expect(script).toContain("complete -F _crew crew");
      });

      it("offers every top-level command and the global flags", () => {
        for (const command of COMPLETION_SPEC) {
          expect(script).toContain(command.name);
        }

        expect(script).toContain("--help -h --version -v --verbose");
      });

      it("completes enum, file, dir, and string flag values", () => {
        expect(script).toContain(
          '--runner) COMPREPLY=( $(compgen -W "auto safehouse sdx none" -- "$cur") ); return ;;',
        );
        expect(script).toContain(
          '--status) COMPREPLY=( $(compgen -W "todo in-progress in-review done other"',
        );
        expect(script).toContain('--prompt-file) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;');
        expect(script).toContain('--project-dir) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;');
        expect(script).toContain("--repo|--source");
      });

      it("nests subcommand cases for commands with subcommands", () => {
        expect(script).toContain('COMPREPLY=( $(compgen -W "list verify --verbose" -- "$cur") )');
        expect(script).toContain("list) COMPREPLY=");
      });

      it("completes static positional values for completions", () => {
        expect(script).toContain('COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )');
      });
    });

    describe("zsh", () => {
      const script = generateCompletionScript("zsh");

      it("declares the compdef header and registration", () => {
        expect(script.startsWith("#compdef crew")).toBe(true);
        expect(script).toContain("compdef _crew crew");
        expect(script).toContain('if [ "$funcstack[1]" = "_crew" ]; then');
      });

      it("describes commands and subcommands with summaries", () => {
        expect(script).toContain("'init:Create a crew.config.ts'");
        expect(script).toContain("_describe -t subcommands 'source subcommand' source_subcommands");
      });

      it("completes enum values and files via zsh builtins", () => {
        expect(script).toContain("--runner) compadd -- auto safehouse sdx none; return ;;");
        expect(script).toContain("--prompt-file) _files; return ;;");
        expect(script).toContain("--project-dir) _files -/; return ;;");
      });

      it("escapes apostrophes in summaries", () => {
        // "Print groundcrew state or a task status" must not contain a raw quote
        // that would break the single-quoted describe entry.
        expect(script).toContain("'status:Print groundcrew state or a task status'");
      });
    });

    describe("fish", () => {
      const script = generateCompletionScript("fish");

      it("registers command completions gated on the current token", () => {
        expect(script).toContain(
          `complete -c crew -f -n '__fish_use_subcommand' -a init -d "Create a crew.config.ts"`,
        );
      });

      it("gates subcommand flags on the seen subcommand", () => {
        expect(script).toContain(
          `complete -c crew -n '__fish_seen_subcommand_from task; and __fish_seen_subcommand_from list' -l status -x -a "todo in-progress in-review done other" -d "Filter by status"`,
        );
      });

      it("uses path completion for file and dir flags", () => {
        expect(script).toContain("-l prompt-file -r -F");
        expect(script).toContain(`-l project-dir -x -a "(__fish_complete_directories)"`);
      });

      it("offers shells as positional values for completions", () => {
        expect(script).toContain(
          `complete -c crew -f -n '__fish_seen_subcommand_from completions; and not __fish_seen_subcommand_from bash zsh fish' -a "bash zsh fish" -d "Shell"`,
        );
      });
    });
  });

  describe("cli command", () => {
    it.each(SUPPORTED_SHELLS)("prints the %s completion script", async (shell) => {
      const log = captureConsoleLog();
      const expected = generateCompletionScript(shell);

      await completionsCli([shell]);
      const actual = log.output();
      log.restore();

      expect(actual).toBe(expected);
    });

    it("rejects when no shell is given", async () => {
      await expect(completionsCli([])).rejects.toThrow("Usage: crew completions <bash|zsh|fish>");
    });

    it("rejects extra positional arguments", async () => {
      await expect(completionsCli(["bash", "extra"])).rejects.toThrow(
        "Usage: crew completions <bash|zsh|fish>",
      );
    });

    it("rejects an unsupported shell", async () => {
      await expect(completionsCli(["powershell"])).rejects.toThrow(
        "crew completions: unsupported shell: powershell",
      );
    });
  });
});
