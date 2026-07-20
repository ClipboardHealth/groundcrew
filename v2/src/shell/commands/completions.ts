/**
 * `crew completions <shell>`: print a static completion script for bash, zsh, or
 * fish (contracts §7, prototype). Minimal by design — the command list is
 * hand-maintained here; commander does not generate these.
 */
import { CliError } from "../errors.js";
import type { Io } from "../io.js";

const SHELLS = ["bash", "zsh", "fish"] as const;
type SupportedShell = (typeof SHELLS)[number];

const COMMANDS = [
  "start",
  "status",
  "pause",
  "resume",
  "cleanup",
  "source",
  "repo",
  "artifact",
  "done",
  "init",
  "doctor",
  "upgrade",
  "completions",
] as const;

export function runCompletions(input: { readonly shell: string; readonly io: Io }): void {
  const shell = SHELLS.find((supportedShell) => supportedShell === input.shell);
  if (shell === undefined) {
    throw new CliError(
      `unsupported shell "${input.shell}" (expected one of ${SHELLS.join(", ")})`,
    );
  }

  input.io.out(scriptFor(shell));
}

function scriptFor(shell: SupportedShell): string {
  const commands = COMMANDS.join(" ");
  switch (shell) {
    case "bash": {
      return [
        "# crew bash completion",
        "_crew_completions() {",
        // oxlint-disable-next-line no-template-curly-in-string -- literal bash completion syntax
        '  local cur="${COMP_WORDS[COMP_CWORD]}"',
        `  COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )`,
        "}",
        "complete -F _crew_completions crew",
      ].join("\n");
    }
    case "zsh": {
      return [
        "#compdef crew",
        "_crew() {",
        `  local -a commands; commands=(${commands})`,
        "  _describe 'command' commands",
        "}",
        "_crew",
      ].join("\n");
    }
    case "fish": {
      return COMMANDS.map(
        (command) =>
          `complete -c crew -n __fish_use_subcommand -a ${command}`,
      ).join("\n");
    }
    default: {
      throw new Error("unreachable supported shell");
    }
  }
}
