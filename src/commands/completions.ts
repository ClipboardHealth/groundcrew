/**
 * Emits shell completion scripts for the `crew` CLI. The command tree is
 * declared once in `COMPLETION_SPEC` below and rendered into bash, zsh, and
 * fish scripts. Keep the spec in sync with the parsers in this directory; the
 * `completions.test.ts` drift guard asserts the top-level command names match
 * the visible entries in `SUBCOMMANDS` (see `../cli.ts`).
 */

import { LOCAL_RUNNER_SETTINGS } from "../lib/config.ts";
import { shellSingleQuote } from "../lib/shell.ts";
import { writeOutput } from "../lib/util.ts";

/** Describes the value a flag consumes, driving per-shell value completion. */
type CompletionArg =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "file" }
  | { readonly kind: "dir" }
  | { readonly kind: "string" };

interface CompletionOption {
  readonly name: string;
  readonly short?: string;
  readonly summary: string;
  /** Omitted for boolean flags; present when the flag takes a value. */
  readonly arg?: CompletionArg;
}

export interface CompletionCommand {
  readonly name: string;
  readonly summary: string;
  readonly options?: readonly CompletionOption[];
  readonly subcommands?: readonly CompletionCommand[];
  /** Static positional values (e.g. `crew completions <shell>`). */
  readonly argValues?: readonly string[];
}

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;

export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

// `--runner` values come from the canonical list in config.ts so completions
// never drift from what `crew init --runner` accepts. Agent and status values
// have no exported canonical array to import, so they stay as local literals.
const AGENT_VALUES = ["claude", "codex"] as const;
const STATUS_VALUES = ["todo", "in-progress", "in-review", "done", "other"] as const;

const AGENT_OPTION: CompletionOption = {
  name: "--agent",
  summary: "Agent name",
  arg: { kind: "enum", values: AGENT_VALUES },
};
const REPO_OPTION: CompletionOption = {
  name: "--repo",
  summary: "Repository (owner/repo)",
  arg: { kind: "string" },
};
const SOURCE_OPTION: CompletionOption = {
  name: "--source",
  summary: "Task source name",
  arg: { kind: "string" },
};
const JSON_OPTION: CompletionOption = { name: "--json", summary: "Print JSON output" };
const DRY_RUN_OPTION: CompletionOption = { name: "--dry-run", summary: "Preview without acting" };

/**
 * The single source of truth for shell completions. Ordering mirrors
 * `crew --help`; hidden and deprecated commands are intentionally excluded.
 */
export const COMPLETION_SPEC: readonly CompletionCommand[] = [
  {
    name: "init",
    summary: "Create a crew.config.ts",
    options: [
      { name: "--global", summary: "Write into the XDG config dir" },
      { name: "--local", summary: "Write into the current directory" },
      { name: "--force", summary: "Overwrite an existing config" },
      DRY_RUN_OPTION,
      { name: "--project-dir", summary: "Workspace project directory", arg: { kind: "dir" } },
      REPO_OPTION,
      {
        name: "--runner",
        summary: "Sandbox runner",
        arg: { kind: "enum", values: LOCAL_RUNNER_SETTINGS },
      },
      AGENT_OPTION,
    ],
  },
  {
    name: "run",
    summary: "Run the orchestrator over eligible tasks",
    options: [{ name: "--watch", summary: "Poll continuously" }, DRY_RUN_OPTION],
  },
  {
    name: "start",
    summary: "Launch one task immediately",
    options: [DRY_RUN_OPTION],
  },
  {
    name: "doctor",
    summary: "Verify host prerequisites",
  },
  {
    name: "source",
    summary: "Inspect configured task sources",
    subcommands: [
      { name: "list", summary: "List configured sources", options: [JSON_OPTION] },
      { name: "verify", summary: "Verify one or all sources", options: [JSON_OPTION] },
    ],
  },
  {
    name: "task",
    summary: "List, get, create, and complete tasks",
    subcommands: [
      {
        name: "list",
        summary: "List tasks across sources",
        options: [
          SOURCE_OPTION,
          {
            name: "--status",
            summary: "Filter by status",
            arg: { kind: "enum", values: STATUS_VALUES },
          },
          { name: "--agent", summary: "Filter by agent name", arg: { kind: "string" } },
          REPO_OPTION,
          { name: "--blocked", summary: "Show only blocked tasks" },
          { name: "--unblocked", summary: "Show only unblocked tasks" },
          JSON_OPTION,
          { name: "--limit", summary: "Limit output count", arg: { kind: "string" } },
        ],
      },
      {
        name: "get",
        summary: "Get one task",
        options: [
          SOURCE_OPTION,
          JSON_OPTION,
          { name: "--prompt", summary: "Print only the task prompt" },
        ],
      },
      {
        name: "create",
        summary: "Create one task",
        options: [
          SOURCE_OPTION,
          { name: "--agent", summary: "Assign an agent", arg: { kind: "string" } },
          REPO_OPTION,
          { name: "--team", summary: "Team key", arg: { kind: "string" } },
          { name: "--id", summary: "Explicit task id", arg: { kind: "string" } },
          { name: "--priority", summary: "Priority", arg: { kind: "string" } },
          { name: "--project", summary: "Project (repeatable)", arg: { kind: "string" } },
          { name: "--context", summary: "Context tag (repeatable)", arg: { kind: "string" } },
          { name: "--dep", summary: "Dependency (repeatable)", arg: { kind: "string" } },
          { name: "--due", summary: "Due date", arg: { kind: "string" } },
          { name: "--rec", summary: "Recurrence", arg: { kind: "string" } },
          { name: "--prompt-file", summary: "Read prompt from file", arg: { kind: "file" } },
          { name: "--description", summary: "Task description", arg: { kind: "string" } },
          { name: "--edit", summary: "Open an editor" },
          JSON_OPTION,
        ],
      },
      {
        name: "done",
        summary: "Mark one task done",
        options: [{ name: "--allow-dirty", summary: "Allow a dirty worktree" }],
      },
      {
        name: "validate",
        summary: "Validate task content",
        options: [JSON_OPTION],
      },
    ],
  },
  {
    name: "status",
    summary: "Print groundcrew state or a task status",
  },
  {
    name: "cleanup",
    summary: "Tear down a worktree, or all idle worktrees",
    options: [
      { name: "--force", summary: "Skip confirmations" },
      { name: "--all", summary: "Clean up every idle worktree" },
    ],
  },
  {
    name: "stop",
    summary: "Stop a live task workspace",
    options: [{ name: "--reason", summary: "Reason text", arg: { kind: "string" } }],
  },
  {
    name: "resume",
    summary: "Reopen an existing task worktree",
    options: [{ name: "--new", summary: "Start a fresh chat session" }],
  },
  {
    name: "open",
    summary: "Open a PR or branch in a new worktree",
    options: [
      { name: "--branch", summary: "Branch name", arg: { kind: "string" } },
      REPO_OPTION,
      AGENT_OPTION,
      { name: "--prompt", summary: "Prompt text", arg: { kind: "string" } },
      { name: "--prompt-file", summary: "Read prompt from file", arg: { kind: "file" } },
      { name: "--task", summary: "Associate a task id", arg: { kind: "string" } },
      DRY_RUN_OPTION,
    ],
  },
  {
    name: "upgrade",
    summary: "Install the latest version of crew",
  },
  {
    name: "completions",
    summary: "Print a shell completion script",
    argValues: SUPPORTED_SHELLS,
  },
];

/** Global flags valid only as the first token. */
const TOP_LEVEL_GLOBALS: readonly CompletionOption[] = [
  { name: "--help", short: "-h", summary: "Show help" },
  { name: "--version", short: "-v", summary: "Print version" },
  { name: "--verbose", summary: "Show diagnostic output" },
];

/** The one global flag every subcommand tolerates (stripped before dispatch). */
const COMMAND_GLOBAL = "--verbose";

function optionTokens(options: readonly CompletionOption[] | undefined): string[] {
  return (options ?? []).flatMap((option) =>
    option.short === undefined ? [option.name] : [option.name, option.short],
  );
}

/** Collects every value-taking flag across the tree, keyed by flag name. */
function valueArgsByName(): Map<string, CompletionArg> {
  const result = new Map<string, CompletionArg>();
  function visit(command: CompletionCommand): void {
    for (const option of command.options ?? []) {
      if (option.arg !== undefined) {
        result.set(option.name, option.arg);
      }
    }
    for (const subcommand of command.subcommands ?? []) {
      visit(subcommand);
    }
  }

  for (const command of COMPLETION_SPEC) {
    visit(command);
  }

  return result;
}

/** Appends the one global flag (`--verbose`) every subcommand tolerates. */
function withVerbose(tokens: string[]): string {
  return [...tokens, COMMAND_GLOBAL].join(" ");
}

/**
 * Walks every value-taking flag once and emits a per-shell `case` line via the
 * given templates. Enum/file/dir flags each get their own line; plain string
 * flags collapse into one fall-through case that offers no completion.
 */
function valueCases(render: {
  enum: (name: string, values: readonly string[]) => string;
  file: (name: string) => string;
  dir: (name: string) => string;
  string: (names: string[]) => string;
}): string {
  const lines: string[] = [];
  const stringNames: string[] = [];
  for (const [name, arg] of valueArgsByName()) {
    if (arg.kind === "enum") {
      lines.push(render.enum(name, arg.values));
    } else if (arg.kind === "file") {
      lines.push(render.file(name));
    } else if (arg.kind === "dir") {
      lines.push(render.dir(name));
    } else {
      stringNames.push(name);
    }
  }

  lines.push(render.string(stringNames));
  return lines.join("\n");
}

// -- bash ------------------------------------------------------------------

function bashValueCases(): string {
  return valueCases({
    enum: (name, values) =>
      `    ${name}) COMPREPLY=( $(compgen -W "${values.join(" ")}" -- "$cur") ); return ;;`,
    file: (name) => `    ${name}) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;`,
    dir: (name) => `    ${name}) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;`,
    string: (names) => `    ${names.join("|")}) return ;;`,
  });
}

function bashCommandCase(command: CompletionCommand): string {
  if (command.subcommands !== undefined) {
    const subNames = command.subcommands.map((sub) => sub.name);
    const subCases = command.subcommands
      .map(
        (sub) =>
          `          ${sub.name}) COMPREPLY=( $(compgen -W "${withVerbose(optionTokens(sub.options))}" -- "$cur") ) ;;`,
      )
      .join("\n");
    return [
      `    ${command.name})`,
      `      if [ -z "$subcommand" ]; then`,
      `        COMPREPLY=( $(compgen -W "${withVerbose(subNames)}" -- "$cur") )`,
      `      else`,
      `        case "$subcommand" in`,
      subCases,
      `        esac`,
      `      fi`,
      `      ;;`,
    ].join("\n");
  }

  if (command.argValues !== undefined) {
    return [
      `    ${command.name})`,
      `      if [ -z "$subcommand" ]; then`,
      `        COMPREPLY=( $(compgen -W "${command.argValues.join(" ")}" -- "$cur") )`,
      `      fi`,
      `      ;;`,
    ].join("\n");
  }

  return [
    `    ${command.name})`,
    `      COMPREPLY=( $(compgen -W "${withVerbose(optionTokens(command.options))}" -- "$cur") )`,
    `      ;;`,
  ].join("\n");
}

function bashScript(): string {
  const commandNames = COMPLETION_SPEC.map((command) => command.name).join(" ");
  const topGlobals = optionTokens(TOP_LEVEL_GLOBALS).join(" ");
  const commandCases = COMPLETION_SPEC.map(bashCommandCase).join("\n");
  return `# bash completion for crew
# Install: source <(crew completions bash)
_crew() {
  local cur prev cmd subcommand i word
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
${bashValueCases()}
  esac

  cmd=""
  subcommand=""
  for (( i=1; i < COMP_CWORD; i++ )); do
    word="\${COMP_WORDS[i]}"
    case "$word" in -*) continue ;; esac
    if [ -z "$cmd" ]; then
      cmd="$word"
    elif [ -z "$subcommand" ]; then
      subcommand="$word"
    fi
  done

  if [ -z "$cmd" ]; then
    COMPREPLY=( $(compgen -W "${commandNames} ${topGlobals}" -- "$cur") )
    return
  fi

  case "$cmd" in
${commandCases}
    *)
      COMPREPLY=( $(compgen -W "${COMMAND_GLOBAL}" -- "$cur") )
      ;;
  esac
}
complete -F _crew crew
`;
}

// -- zsh -------------------------------------------------------------------

function zshValueCases(): string {
  return valueCases({
    enum: (name, values) => `    ${name}) compadd -- ${values.join(" ")}; return ;;`,
    file: (name) => `    ${name}) _files; return ;;`,
    dir: (name) => `    ${name}) _files -/; return ;;`,
    string: (names) => `    ${names.join("|")}) return ;;`,
  });
}

function zshDescribeArray(name: string, entries: readonly CompletionCommand[]): string {
  const items = entries
    .map((entry) => `    ${shellSingleQuote(`${entry.name}:${entry.summary}`)}`)
    .join("\n");
  return [`  local -a ${name}`, `  ${name}=(`, items, `  )`].join("\n");
}

function zshCommandCase(command: CompletionCommand): string {
  if (command.subcommands !== undefined) {
    const subCases = command.subcommands
      .map(
        (sub) => `          ${sub.name}) compadd -- ${withVerbose(optionTokens(sub.options))} ;;`,
      )
      .join("\n");
    return [
      `    ${command.name})`,
      `      if [[ -z $subcommand ]]; then`,
      zshDescribeArray(`${command.name}_subcommands`, command.subcommands)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
      `        _describe -t subcommands '${command.name} subcommand' ${command.name}_subcommands`,
      `      else`,
      `        case $subcommand in`,
      subCases,
      `        esac`,
      `      fi`,
      `      ;;`,
    ].join("\n");
  }

  if (command.argValues !== undefined) {
    return [
      `    ${command.name})`,
      `      if [[ -z $subcommand ]]; then compadd -- ${command.argValues.join(" ")}; fi`,
      `      ;;`,
    ].join("\n");
  }

  return [
    `    ${command.name})`,
    `      compadd -- ${withVerbose(optionTokens(command.options))}`,
    `      ;;`,
  ].join("\n");
}

function zshScript(): string {
  const topGlobals = optionTokens(TOP_LEVEL_GLOBALS).join(" ");
  const commandCases = COMPLETION_SPEC.map(zshCommandCase).join("\n");
  return `#compdef crew
# zsh completion for crew
# Install: crew completions zsh > "\${fpath[1]}/_crew"  (or: source <(crew completions zsh))
_crew() {
  local cur prev cmd subcommand i word
${zshDescribeArray("commands", COMPLETION_SPEC)}
  cur=$words[CURRENT]
  prev=$words[CURRENT-1]

  case $prev in
${zshValueCases()}
  esac

  cmd=""
  subcommand=""
  for (( i=2; i < CURRENT; i++ )); do
    word=$words[i]
    case $word in -*) continue ;; esac
    if [[ -z $cmd ]]; then
      cmd=$word
    elif [[ -z $subcommand ]]; then
      subcommand=$word
    fi
  done

  if [[ -z $cmd ]]; then
    _describe -t commands 'crew command' commands
    compadd -- ${topGlobals}
    return
  fi

  case $cmd in
${commandCases}
    *)
      compadd -- ${COMMAND_GLOBAL}
      ;;
  esac
}

# Support both fpath autoload and sourcing (source <(crew completions zsh)).
if [ "$funcstack[1]" = "_crew" ]; then
  _crew "$@"
else
  compdef _crew crew
fi
`;
}

// -- fish ------------------------------------------------------------------

function fishDescription(summary: string): string {
  return summary.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function fishArgFlags(arg: CompletionArg | undefined): string {
  if (arg === undefined) {
    return "";
  }
  if (arg.kind === "enum") {
    return ` -x -a "${arg.values.join(" ")}"`;
  }
  if (arg.kind === "file") {
    return " -r -F";
  }
  if (arg.kind === "dir") {
    return ` -x -a "(__fish_complete_directories)"`;
  }
  return " -x";
}

function fishOptionLine(condition: string, option: CompletionOption): string {
  // Command/subcommand options never carry short forms (only the top-level
  // globals do, and those are emitted separately), so this renders long flags.
  const long = option.name.replace(/^--/, "");
  return `complete -c crew -n '${condition}' -l ${long}${fishArgFlags(option.arg)} -d "${fishDescription(option.summary)}"`;
}

function fishOptionLines(
  condition: string,
  options: readonly CompletionOption[] | undefined,
): string[] {
  return (options ?? []).map((option) => fishOptionLine(condition, option));
}

function fishCommandLines(command: CompletionCommand): string[] {
  const lines: string[] = [];
  const seenCondition = `__fish_seen_subcommand_from ${command.name}`;

  lines.push(...fishOptionLines(seenCondition, command.options));

  if (command.subcommands !== undefined) {
    const subNames = command.subcommands.map((sub) => sub.name).join(" ");
    const chooseSub = `${seenCondition}; and not __fish_seen_subcommand_from ${subNames}`;
    for (const sub of command.subcommands) {
      lines.push(
        `complete -c crew -f -n '${chooseSub}' -a ${sub.name} -d "${fishDescription(sub.summary)}"`,
      );
      const subCondition = `${seenCondition}; and __fish_seen_subcommand_from ${sub.name}`;
      lines.push(...fishOptionLines(subCondition, sub.options));
    }
  }

  if (command.argValues !== undefined) {
    const chooseArg = `${seenCondition}; and not __fish_seen_subcommand_from ${command.argValues.join(" ")}`;
    lines.push(
      `complete -c crew -f -n '${chooseArg}' -a "${command.argValues.join(" ")}" -d "Shell"`,
    );
  }

  return lines;
}

function fishScript(): string {
  const commandLines = COMPLETION_SPEC.map(
    (command) =>
      `complete -c crew -f -n '__fish_use_subcommand' -a ${command.name} -d "${fishDescription(command.summary)}"`,
  );
  const globalLines = [
    `complete -c crew -l verbose -d "Show diagnostic output"`,
    `complete -c crew -n '__fish_use_subcommand' -l help -s h -d "Show help"`,
    `complete -c crew -n '__fish_use_subcommand' -l version -s v -d "Print version"`,
  ];
  const perCommandLines = COMPLETION_SPEC.flatMap(fishCommandLines);
  return `# fish completion for crew
# Install: crew completions fish > ~/.config/fish/completions/crew.fish
${commandLines.join("\n")}
${globalLines.join("\n")}
${perCommandLines.join("\n")}
`;
}

const GENERATORS: Readonly<Record<SupportedShell, () => string>> = {
  bash: bashScript,
  zsh: zshScript,
  fish: fishScript,
};

/** Renders the completion script for a supported shell. */
export function generateCompletionScript(shell: SupportedShell): string {
  return GENERATORS[shell]();
}

function isSupportedShell(value: string): value is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}

const COMPLETIONS_USAGE = `Usage: crew completions <${SUPPORTED_SHELLS.join("|")}>`;

export async function completionsCli(argv: string[]): Promise<void> {
  const [shell, ...extras] = argv;
  if (shell === undefined || extras.length > 0) {
    throw new Error(COMPLETIONS_USAGE);
  }
  if (!isSupportedShell(shell)) {
    throw new Error(`crew completions: unsupported shell: ${shell}\n${COMPLETIONS_USAGE}`);
  }

  writeOutput(generateCompletionScript(shell));
}
