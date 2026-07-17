/**
 * PROTOTYPE — throwaway. DO NOT SHIP. (DEVOP-5975, groundcrew v2 CLI surface)
 *
 * Question: what is v2's minimal command surface, config shape, and setup-script
 * scope? This renders the proposed `crew --help` output for every command so it
 * can be reacted to like the real thing, plus the config and setup sections.
 *
 * Run:  node --run proto:cli2                  root help
 *       node --run proto:cli2 -- status        one command's help
 *       node --run proto:cli2 -- source doctor subcommand help
 *       node --run proto:cli2 -- config        proposed config shape
 *       node --run proto:cli2 -- setup         setup-script scope
 *       node --run proto:cli2 -- changes       v1 -> v2 disposition (a screen, not a command)
 *       node --run proto:cli2 -- --tour        everything, in order
 */
// oxlint-disable unicorn/no-immediate-mutation -- throwaway prototype, screens read top-to-bottom

const B = "\u001B[1m";
const D = "\u001B[2m";
const R = "\u001B[0m";

function h(text: string): string {
  return text
    .replaceAll(/^([A-Z][\w -]+:)$/gm, `${B}$1${R}`)
    .replaceAll(/^(Usage: .+)$/gm, `${B}$1${R}`)
    .replaceAll(/\{\{dim:([^}]*)\}\}/g, `${D}$1${R}`);
}

const screens = new Map<string, string>();

screens.set(
  "root",
  `Usage: crew [options] [command]

Dispatch task backlogs to sandboxed AI coding agents — one agent session per
task, over a workspace of worktrees.

Options:
  -v, --version             print version
  --verbose                 diagnostic output {{dim:(env: GROUNDCREW_VERBOSE)}}
  -h, --help                display help for command

Operate:
  start [options] [task]    poll sources and dispatch eligible tasks, or one task
  status [task]             queue, workspaces, sources — observed vs reported
  pause <task>              suspend a running task, preserving its workspace
  resume [options] <task>   reopen a paused task's agent conversation
  cleanup [options] [task]  tear down workspaces

Sources:
  source list               discovered task sources and their capabilities
  source doctor [name]      per-source deep check: contract, secrets, sandbox

In-session {{dim:(run by the agent, inside a task workspace)}}:
  repo add <repo>           acquire a repo worktree into the task workspace
  artifact add <locator>    report an artifact produced for the task
  done [options] [task]     report completion; triggers source writeback

Setup:
  init [options]            write config interactively and verify the host
  doctor                    check prerequisites, config, and source contracts
  upgrade [version]         install the latest (or pinned) version of crew
  completions <shell>       print a shell completion script

{{dim:Every command reconciles on startup: on-disk worktrees, multiplexer sessions,}}
{{dim:and sandboxes are the source of truth; orphans are reported (cleanup removes).}}`,
);

screens.set(
  "start",
  `Usage: crew start [options] [task]

Without a task: poll every configured source and dispatch the eligible ready
tasks — unblocked, agent capacity available. One-shot by default.

With a task: dispatch just that one, same eligibility checks. The repo gate
always applies: a designated repo missing from workspace.baseDirectory bails with
"repo not found" — --force never overrides it.

Arguments:
  task                      task id {{dim:(canonical source:id, or unique prefix)}}

Options:
  --watch                   poll continuously {{dim:(without a task)}}
  --force                   dispatch even if blocked or at capacity {{dim:(with a task)}}
  --agent <profile>         override the task's routed agent profile {{dim:(with a task)}}
  --dry-run                 show the dispatch plan, dispatch nothing
  -h, --help                display help for command

{{dim:Absorbs v1's "run" — one dispatch verb, aligned with pause/resume/done.}}`,
);

screens.set(
  "status",
  `Usage: crew status [options] [task]

Without a task: source queues, active workspaces, slot usage, and anything
reconcile flagged (orphans, protocol mismatches, sandbox opt-outs).

With a task: full detail on two clearly separated layers —
  observed   workspace-local git facts groundcrew verified itself
             {{dim:(worktrees, branches, commits, dirty state)}}
  reported   what the agent said via crew artifact add / crew done
             {{dim:("PR reported" — groundcrew knows no forge and never checks)}}

Arguments:
  task                      task id or unique prefix

Options:
  --json                    machine-readable output
  -h, --help                display help for command`,
);

screens.set(
  "pause",
  `Usage: crew pause [options] <task>

Suspend a running task: capture the agent's session id (where the harness
exposes one — Claude Code and Codex do), end the session process, and keep
the workspace and all worktrees intact. Run state: running -> paused.
crew resume reopens the same conversation.

Arguments:
  task                      task id or unique prefix

Options:
  --reason <text>           note recorded on the task's run state
  -h, --help                display help for command

{{dim:v1's "stop" — renamed to match the run-state machine (running <-> paused).}}
{{dim:Terminal stop is crew done --outcome stopped, or crew cleanup.}}`,
);

screens.set(
  "resume",
  `Usage: crew resume [options] <task>

Reopen a paused task's workspace and resume the same agent conversation, via
the session id captured at pause ({{dim:{{sessionId}}}} in the profile's resume
command). Falls back to the profile's resumeArguments when no id was
captured. Run state: paused -> running.

Arguments:
  task                      task id or unique prefix

Options:
  --fresh                   start a new conversation instead of resuming
  -h, --help                display help for command`,
);

screens.set(
  "cleanup",
  `Usage: crew cleanup [options] [task]

Tear down a task workspace: worktrees, session, sandbox. A task that never
completed is completed as outcome: stopped (writeback fires if the source
supports it). With --all, tears down every idle workspace and removes
reconcile-flagged orphans.

Arguments:
  task                      task id or unique prefix {{dim:(omit with --all)}}

Options:
  --all                     every idle workspace + orphans
  --force                   proceed despite uncommitted changes
  -h, --help                display help for command`,
);

screens.set(
  "source",
  `Usage: crew source [command]

Inspect the discovered task sources (package bundles and user bundles from
~/.config/groundcrew/task-sources/).

Commands:
  list [--json]             name, origin, protocol, capabilities, sandbox
  doctor [name] [--json]    per-source deep check
  -h, --help                display help for command`,
);

screens.set(
  "source list",
  `Usage: crew source list [options]

List every discovered source. Columns:

  NAME          effective name {{dim:(defaults to kind; unique)}}
  ORIGIN        package | user {{dim:(user bundles shadow package bundles by name)}}
  PROTOCOL      manifest protocolVersion, flagged loudly if unsupported
  CAPABILITIES  list, get, update {{dim:(update absent => read-only, writeback no-ops)}}
  SANDBOX       sandboxed {{dim:(default)}} | OFF {{dim:(per-source opt-out — loud)}}
  EGRESS        declared network allowlist

Options:
  --json                    machine-readable output
  -h, --help                display help for command`,
);

screens.set(
  "source doctor",
  `Usage: crew source doctor [options] [name]

The same source checks crew doctor runs, scoped to one source (or all) and
deeper: manifest parses, protocolVersion supported, prerequisites on PATH,
declared secrets resolvable, sandbox profile builds, then a live list
round-trip under the sandbox.

Arguments:
  name                      source name {{dim:(omit to check all)}}

Options:
  --json                    machine-readable output
  -h, --help                display help for command

{{dim:Absorbs v1's "source verify" and "task validate"; one health-check verb}}
{{dim:everywhere: doctor.}}`,
);

screens.set(
  "repo add",
  `Usage: crew repo add [options] <repo>

Acquire a worktree for <repo> into the current task's workspace, on the task
branch, and run the repo's prepareWorktree hook. Requires <repo> to already
be cloned under workspace.baseDirectory — groundcrew never clones.

Arguments:
  repo                      repo directory name under workspace.baseDirectory

Options:
  --task <id>               explicit task {{dim:(default: inferred, see below)}}
  -h, --help                display help for command

Task identity resolution {{dim:(all in-session commands)}}:
  1. --task <id> explicit flag
  2. $GROUNDCREW_WORKSPACE {{dim:(injected into the agent session at launch)}}
  3. walk up from cwd to a .groundcrew/task.json workspace marker

Exit codes:
  2  repo not cloned under baseDirectory {{dim:("clone it yourself, then re-run")}}
  3  no task context {{dim:(not inside a task workspace and no --task)}}`,
);

screens.set(
  "artifact add",
  `Usage: crew artifact add [options] <locator>

Report an artifact (PR URL, document link, file path, ticket id, ...) for the
current task. Artifacts accumulate on the task record and flow to the source
in the completed writeback. Groundcrew records the claim without checking it
— status renders it as "reported".

Arguments:
  locator                   URL, path, or id identifying the artifact

Options:
  --kind <kind>             pr | branch | document | file | ticket | ...
                            {{dim:(open set; default: guessed from the locator)}}
  --title <text>            human-readable label
  --repo <name>             repo this artifact belongs to, when relevant
  --task <id>               explicit task {{dim:(default: inferred)}}
  -h, --help                display help for command`,
);

screens.set(
  "done",
  `Usage: crew done [options] [task]

Report completion: sends completed { outcome, artifacts, message } to the
task's source (writeback no-ops on read-only sources). Run state:
-> complete. In-session the task is inferred; humans pass it explicitly.

Refuses when a worktree is dirty and no artifact was reported for that repo,
unless --allow-dirty.

Arguments:
  task                      task id {{dim:(default: inferred from session context)}}

Options:
  --outcome <outcome>       delivered | failed | stopped {{dim:(default: delivered)}}
  --message <text>          note delivered with the writeback
  --allow-dirty             skip the dirty-worktree guard
  -h, --help                display help for command

{{dim:Replaces v1's "task done" and the $GROUNDCREW_COMPLETE env indirection —}}
{{dim:the default prompt just says: run \`crew done\` when finished. The protocol's}}
{{dim:"progress" event has no CLI command in v2.0; add one if the need shows up.}}`,
);

screens.set(
  "init",
  `Usage: crew init [options]

Interactive setup, safe to re-run:

  1. pick workspace.baseDirectory       {{dim:(detects likely candidates, e.g. ~/dev)}}
  2. detect agents on PATH        {{dim:(claude, codex, cursor-agent -> presets)}}
  3. pick sources                 {{dim:(linear if its secret resolves; todo-txt default)}}
  4. write crew.config.jsonc      {{dim:(global: ~/.config/groundcrew/)}}
  5. run crew doctor

Detecting a v1 config (crew.config.ts) offers conversion: writes the v2
equivalent alongside it and prints every dropped/renamed key with why.

Options:
  --local                   write ./crew.config.jsonc instead of global
  --yes                     accept detected defaults, no prompts {{dim:(for scripts/CI)}}
  --force                   overwrite an existing config
  --dry-run                 print the config that would be written
  -h, --help                display help for command

{{dim:init never: clones repos, creates API keys, or installs agent CLIs.}}`,
);

screens.set(
  "doctor",
  `Usage: crew doctor [options]

Verify the host end to end: required tools on PATH (git, multiplexer, srt),
config parses and validates, every discovered source checks clean (protocol
version, prerequisites, secrets, sandbox), agent profile commands resolve,
no credential-looking strings in the config file, and reconcile finds no
orphans. Exit 0 = ready to crew start.

Options:
  --json                    machine-readable output
  -h, --help                display help for command`,
);

screens.set(
  "upgrade",
  `Usage: crew upgrade [version]

Install the latest version of crew, or pin to a specific version.

Arguments:
  version                   exact version to install {{dim:(default: latest)}}`,
);

screens.set(
  "completions",
  `Usage: crew completions <shell>

Print a shell completion script for bash, zsh, or fish.`,
);

screens.set(
  "config",
  `Proposed config shape {{dim:(crew.config.jsonc — data, not code)}}

Why JSONC: a global TS config can't resolve the package import for its types
(~/.config is outside any node_modules), so TS buys ceremony without safety.
JSONC + a published JSON Schema (generated from the zod schema, pointed at by
$schema) gets editor completion and validation in any editor, and keeps the
config inert data.

Two principles:

  1. Omitted = detected. Specified = exactly yours. Never merged.
     {{dim:sources omitted    -> [{ "kind": "todo-txt" }] (zero credentials)}}
     {{dim:agents omitted     -> presets for CLIs found on PATH (claude > codex > cursor)}}
     {{dim:multiplexer omitted-> first of cmux, tmux, zellij found on PATH}}
     {{dim:Listing anything replaces the detected set — no implicit entries to}}
     {{dim:fight when a CLI isn't installed; disabling = not listing it.}}

  2. No secrets in config, structurally. No schema field accepts a token
     value. Source manifests declare required secret NAMES; values resolve
     from the parent environment or an optional secrets file
     (~/.config/groundcrew/secrets.env, doctor warns unless chmod 600), or a
     wrapper like \`op run\`. Linear is not special: its bundle declares
     secrets: ["LINEAR_API_KEY"] like any other source. doctor flags
     credential-looking strings found in the config file.

Minimal legal config — everything else defaults or detects:

  {
    "$schema": "https://unpkg.com/@clipboard-health/groundcrew/schema.json",
    "workspace": { "baseDirectory": "~/dev" }
  }

Full annotated shape:

  {
    "$schema": "https://unpkg.com/@clipboard-health/groundcrew/schema.json",

    // The only required key. The repo universe IS the disk under baseDirectory;
    // knownRepositories is gone and groundcrew never clones.
    "workspace": {
      "baseDirectory": "~/dev",
      // default: <baseDirectory>/.groundcrew/worktrees — never muddies baseDirectory
      "worktreeDirectory": "~/scratch/worktrees",
      // per-repo overrides only; presence on disk is what enrolls a repo
      "repositories": {
        "backend-main": { "workingDirectory": "packages/api", "prepareWorktree": "npm ci" }
      }
    },

    // Enable discovered bundles by kind. Origin is discovery, not config:
    // package bundles ship in the npm package, user bundles live in
    // ~/.config/groundcrew/task-sources/<name>/.
    "sources": [
      { "kind": "linear" },
      { "kind": "jira", "environment": { "JIRA_GROUNDCREW_JQL": "..." } },  // non-secret only
      { "kind": "my-scraper", "sandbox": false }                            // loud in status/doctor
    ],

    // Agent profiles: declarative harness config (not plugins). model/effort
    // are first-class fields the preset maps to its CLI's flags; {{dim:{{model}}}} /
    // {{dim:{{sessionId}}}} placeholders serve fully custom commands.
    "agents": {
      "default": "claude",
      "profiles": {
        "claude": {},                                                  // pure preset
        "claude-fast": { "model": "claude-sonnet-5", "effort": "medium" },
        "my-agent": { "command": "my-agent --model {{dim:{{model}}}}", "model": "m9",
                      "resume": "my-agent --resume {{dim:{{sessionId}}}}" }
      }
    },

    // Optional knobs, all defaulted (no abbreviations):
    "orchestrator": {
      "maximumInProgress": 4,
      "pollIntervalMilliseconds": 120000,
      "sessionLimitPercentage": 85
    },
    "git": { "remote": "origin", "defaultBranch": "main", "branchPrefix": "rocky" },
    "multiplexer": "tmux",                          // cmux | tmux | zellij; default: detect
    "sandbox": { "readOnlyDirectories": ["~/.config/tfenv"] },  // srt only; no runner choice
    "prompts": { "initial": "..." },                // or promptFile
    "logging": { "file": "~/.local/state/groundcrew/groundcrew.jsonl" }
  }

Killed from v1 config:
  workspace.knownRepositories        {{dim:disk under baseDirectory is the universe (DEVOP-5967)}}
  local.runner / networkEgress /     {{dim:srt is the only runner; egress moves into}}
    safehouse.enable                 {{dim:source manifests (DEVOP-5973)}}
  sources[kind=shell] generic block  {{dim:bring-your-own-scripts = user-dir bundle}}
  agents cmd-encodes-model           {{dim:model/effort/resume are fields now}}
  TS/cosmiconfig format zoo          {{dim:one file name, one format, one location rule}}`,
);

screens.set(
  "setup",
  `Setup-script scope

One-liner installer {{dim:(README front door)}}:

  curl -fsSL https://groundcrew.dev/install.sh | sh

  1. checks for node >= 24, installs @clipboard-health/groundcrew globally
  2. execs crew init            {{dim:(interactive; --yes for CI/dotfiles)}}

crew init automates {{dim:(see crew init --help)}}: baseDirectory detection, agent-preset
detection from PATH, secret-resolution sniffing for source selection, v1
config conversion when found, config write, closing crew doctor run.

Deliberately manual, forever:
  - cloning repos into baseDirectory          {{dim:(acquiring a repo is a human act)}}
  - creating API keys / tokens          {{dim:(printed as copy-paste next steps)}}
  - installing agent CLIs               {{dim:(their installers, their business)}}`,
);

screens.set(
  "changes",
  `v1 -> v2 command disposition {{dim:(a prototype screen, not a proposed command —}}
{{dim:migration aid lives in crew init's v1-config conversion; its final shape}}
{{dim:belongs to the map's migration-easing item)}}

  KEPT      status, resume, cleanup, doctor, init, upgrade, completions
  MERGED    run + start -> start [task]  {{dim:(one dispatch verb, aligned with the}}
            {{dim:start/pause/resume/done lifecycle; --force for eligibility)}}
  RENAMED   stop -> pause                {{dim:(matches run-state machine vocabulary)}}
            source verify -> source doctor {{dim:(one health-check verb everywhere)}}
            task done -> done            {{dim:(top-level; in-session first-class)}}
  NEW       repo add, artifact add {{dim:(in-session, from DEVOP-5967/5968)}}
  KILLED    open            {{dim:("review PR X" is just a task; halves provisioning paths)}}
            task create     {{dim:(create dropped from source contract; use the tracker)}}
            task list/get   {{dim:(status is the one place to look; --json for scripts)}}
            task validate   {{dim:(absorbed by source doctor)}}
            source install  {{dim:(distribution is not groundcrew's problem — v2.0)}}
            interrupt, sandbox, setup, crew-clearance-ensure bin {{dim:(already dead/dying)}}

  Leaf-command count: v1 ~20 -> v2 14.

Env surface:
  KEPT      GROUNDCREW_CONFIG, GROUNDCREW_VERBOSE
  NEW       GROUNDCREW_WORKSPACE, GROUNDCREW_TASK_ID {{dim:(injected in-session)}}
  KILLED    GROUNDCREW_COMPLETE {{dim:(prompt says "run crew done"; no indirection)}}
            GROUNDCREW_LINEAR_API_KEY {{dim:(linear bundle declares LINEAR_API_KEY}}
            {{dim:like any other source secret — nothing is special-cased)}}`,
);

const TOUR_ORDER = [
  "root",
  "start",
  "status",
  "pause",
  "resume",
  "cleanup",
  "source",
  "source list",
  "source doctor",
  "repo add",
  "artifact add",
  "done",
  "init",
  "doctor",
  "upgrade",
  "completions",
  "config",
  "setup",
  "changes",
];

function banner(): void {
  console.log(`${D}PROTOTYPE — proposed groundcrew v2 CLI (DEVOP-5975). Nothing here runs.${R}\n`);
}

const args = process.argv.slice(2);

if (args[0] === "--tour") {
  banner();
  for (const key of TOUR_ORDER) {
    console.log(`${B}${"═".repeat(74)}${R}`);
    console.log(`${B}  ${key === "root" ? "crew --help" : `crew ${key} --help`}${R}`);
    console.log(`${B}${"═".repeat(74)}${R}\n`);
    console.log(h(screens.get(key) ?? ""));
    console.log("");
  }
} else {
  const key = args.filter((argument) => !argument.startsWith("-")).join(" ");
  const screen = screens.get(key === "" ? "root" : key);
  banner();
  if (screen === undefined) {
    console.log(h(screens.get("root") ?? ""));
    console.log(`\n${D}Unknown screen "${key}". Screens: ${TOUR_ORDER.join(", ")}${R}`);
  } else {
    console.log(h(screen));
    if (key === "") {
      console.log(
        `\n${D}Also: node --run proto:cli2 -- <command|config|setup|changes> or --tour${R}`,
      );
    }
  }
}
