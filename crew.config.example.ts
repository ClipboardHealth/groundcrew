import type { Config } from "@clipboard-health/groundcrew";
// import { readFileSync } from "node:fs";

export default {
  // Task sources — at least one is required; add a `sources` array to get
  // started. Two built-in options:
  //
  //   Zero credentials: use a local todo.txt file. No API key needed.
  //   sources: [{ kind: "todo-txt" }]
  //
  //   Linear: picks up issues assigned to your API key's viewer that carry
  //   an `agent-*` label. Requires GROUNDCREW_LINEAR_API_KEY.
  //   sources: [{ kind: "linear" }]
  //
  // Running `crew run` without a sources array will print this guidance and exit.
  workspace: {
    // Parent directory under which groundcrew clones repositories and (by
    // default) creates per-task worktrees.
    projectDir: "~/dev/groundcrew",
    // Optional: collect ALL worktrees here instead of beside each repo. Useful
    // when your repos live in more than one place. Defaults to projectDir.
    // worktreeDir: "~/dev/worktrees",
    // Repositories groundcrew is allowed to set up worktrees in. Add
    // `<owner>/<repo>` or bare `<repo>` strings; the orchestrator scopes
    // tasks to these and refuses unknown repos by default. Use the object
    // form to point a repo at a different parent directory:
    //   { name: "other-org/other-repo", projectDirOverride: "~/work" }
    knownRepositories: ["your-org/your-repo"],
    // A knownRepositories entry can also be an object that provisions the
    // worktree with a custom command instead of `git worktree add` — e.g. a
    // sparse checkout via `graft`. `repo` is a logical name (task token +
    // worktree dir basename); the physical clone is the command's concern.
    // Templates interpolate ${branch} ${dir} ${baseRef} ${repo} ${task}.
    //
    //   {
    //     name: "billing",
    //     provision: {
    //       create: "graft new ${branch} billing --from ${baseRef} --dir ${dir}",
    //       remove: "graft rm ${branch} -f",
    //     },
    //     // Optional: run the agent, prepareWorktree hook, and
    //     // .groundcrew/config.json lookup in this subdirectory of the
    //     // checkout (relative, no ".."). Use it when the checkout is a
    //     // monorepo whose project lives in a subdir.
    //     workdir: "services/billing",
    //   },
    //
    // Set up graft once outside groundcrew:
    //   graft repo add ~/dev/owner/monorepo
    //   graft alias add billing services/billing libs/common
    // `crew doctor` does not parse or validate these shell templates.
    //
    // An object entry can also set a per-repo prepareWorktree hook without a
    // committed `.groundcrew/config.json` — handy for third-party repos you
    // don't want to add groundcrew files to. It beats `defaults.hooks` below
    // but still yields to a repo-committed `.groundcrew/config.json`:
    //
    //   {
    //     name: "other-org/their-repo",
    //     hooks: { prepareWorktree: "uv sync --dev --frozen" },
    //   },
  },
  agents: {
    default: "claude",
    // `definitions` is the enabled launch profile set. Built-in keys can use
    // `{}` to opt into the shipped command/color/usage preset. Add
    // `codex: {}`, `cursor: {}`, or `"cursor-grok": {}` for the other shipped
    // agents (`cursor` runs Cursor's composer-2.5, `cursor-grok` runs grok-4.5).
    // Agent names are launch profiles: add custom entries such as `claude-fable`
    // or `claude-opus` to pin a model per task, then tag tasks with `agent-<name>`.
    definitions: {
      claude: {},
      // codex: {},
      // cursor: {},
      // "cursor-grok": {},
      // "claude-fable": {
      //   cmd: "claude --model claude-fable-5 --permission-mode auto",
      //   color: "#C15F3C",
      //   usage: { codexbar: { provider: "claude" } },
      // },
      // "claude-opus": {
      //   cmd: "claude --model claude-opus-4-8 --permission-mode auto",
      //   color: "#8A4FFF",
      //   usage: { codexbar: { provider: "claude" } },
      // },
      // The cursor/cursor-grok presets bypass Cursor's approval prompts for
      // unattended runs: `--force` auto-approves shell/tool commands (unless
      // explicitly denied) and `--approve-mcps` auto-approves MCP servers. To
      // require approvals instead, override cmd without those flags:
      // cursor: {
      //   cmd: "cursor-agent --model composer-2.5 --sandbox disabled",
      //   color: "#8B5CF6",
      // },
    },
  },
  // Repo-preparation hook: runs after each worktree is created and before the
  // agent launches. The default below is a no-op placeholder. Replace it with
  // your repo's setup, e.g. "npm ci" or "uv sync --dev --frozen". This is the
  // lowest-priority layer: a per-repo `knownRepositories[].hooks.prepareWorktree`
  // (above) overrides it, and a repo-committed `.groundcrew/config.json`
  // `hooks.prepareWorktree` overrides both.
  defaults: {
    hooks: {
      prepareWorktree: "true",
    },
  },
  // Everything below is optional — defaults shown for reference. Uncomment
  // and edit to override.
  //
  // // Additional pluggable task sources beyond the implicit built-in
  // // Linear adapter. The most common use is `kind: "shell"`, which wires
  // // any external system via command templates that emit/consume JSON.
  // // See the shell adapter's ShellIssue schema for the JSON contract
  // // `listTasks` / `getTask` must emit.
  // sources: [
  //   // Optional: explicitly declare Linear only when you need custom status
  //   // names. Omitted fields keep their defaults.
  //   {
  //     kind: "linear",
  //     statuses: {
  //       inProgress: ["Doing"],
  //       inReview: ["Code Review"],
  //     },
  //   },
  //   // Optional: disable the built-in Linear source entirely for shell-only
  //   // setups (no Linear API key needed). Replaces the block above.
  //   // { kind: "linear", enabled: false },
  //   {
  //     kind: "shell",
  //     name: "jira",
  //     // Install via task-sources/jira (see task-sources/jira/README.md):
  //     //   cp task-sources/jira/jira.sh ~/.config/groundcrew/jira.sh
  //     // Open local task-store directories for read/write inside the
  //     // safehouse/srt sandbox when this source owns the launched task.
  //     sandboxWritePaths: ["~/plans"],
  //     commands: {
  //       verify: "~/.config/groundcrew/jira.sh verify",
  //       listTasks: "~/.config/groundcrew/jira.sh list",
  //       getTask: "~/.config/groundcrew/jira.sh get ${id}",
  //       markInProgress: "~/.config/groundcrew/jira.sh move ${id} \"$JIRA_STATE_IN_PROGRESS\"",
  //       // Full wiring (markInReview/markDone, env, timeouts): see task-sources/jira/README.md
  //     },
  //     timeouts: { listTasks: 60_000 },
  //   },
  // ],
  //
  // git: { remote: "origin", defaultBranch: "main" },
  //
  // orchestrator: {
  //   maximumInProgress: 4,
  //   pollIntervalMilliseconds: 120_000,
  //   sessionLimitPercentage: 85,
  // },
  //
  // To customize an enabled built-in, replace `claude: {}` above with:
  // claude: {
  //   // Optional: mint a short-lived credential outside Safehouse and forward
  //   // it into the agent. Chain with `&&` so a failed mint aborts launch.
  //   preLaunch: "SESSION_TOKEN=$(your-mint-command) && export SESSION_TOKEN",
  //   preLaunchEnv: ["SESSION_TOKEN"],
  //   // Required for this agent when `local.runner` resolves to `sdx`.
  //   sandbox: { agent: "claude" },
  //   // Args appended on `crew resume` so the agent reopens its previous
  //   // conversation in the worktree (`crew resume --new` starts fresh). The
  //   // built-in claude/codex presets default this ("--continue" / "resume
  //   // --last"); set it for custom agents or to override the preset default.
  //   resumeArgs: "--continue",
  // },
  //
  // // Local isolation backend. Defaults to `"auto"` — macOS → safehouse,
  // // Linux → sdx (Docker Sandboxes). `"none"` is an explicit unsandboxed
  // // escape hatch and is never picked implicitly. Switch to `"sdx"` on
  // // macOS when you need an agent to use Docker safely.
  // local: { runner: "auto" },
  //
  // // Safehouse optional integrations, turned on for every agent launched
  // // under the safehouse runner (forwarded to `safehouse --enable=<list>`).
  // // Each name layers the matching optional sandbox profile on top of the
  // // deny-by-default policy. Examples: `agent-browser` so the
  // // chrome-devtools MCP server can drive a headless Chrome;
  // // `browser-native-messaging` for `claude --chrome`. Ignored by the
  // // srt/sdx/none runners.
  // local: { safehouse: { enable: ["agent-browser"] } },
  //
  // // Groundcrew does not create or authenticate sdx sandboxes. For an sdx
  // // agent, create the matching sandbox yourself before first launch:
  // //   sbx create --name groundcrew-claude claude ~/dev/groundcrew
  // //   sbx exec -it groundcrew-claude claude auth login
  // //   sbx exec -it groundcrew-claude gh auth login
  //
  // prompts: {
  //   // Keep personal workflow instructions next to this config, for example
  //   // `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/initial-prompt.md`.
  //   // If you uncomment this, also uncomment the readFileSync import above.
  //   initial: readFileSync(new URL("./initial-prompt.md", import.meta.url), "utf8"),
  //   // Or, instead of `initial`, point at a file (also works in crew.config.json).
  //   // Resolved relative to this config's directory; `~` and absolute paths work.
  //   // promptFile: "initial-prompt.md",
  // },
  //
  // // Terminal session manager. "auto" picks cmux when on PATH, else tmux.
  // // Set explicitly to "cmux", "tmux", or "zellij" to fail loudly when the
  // // chosen backend is missing. tmux windows / zellij tabs live in a
  // // dedicated `groundcrew` session and lose status-pill painting (a
  // // cmux-only feature).
  // workspaceKind: "auto",
  //
  // logging: {
  //   // Append-mode log file destination. `log()` / `logEvent()` tee here
  //   // in addition to stdout, so a vanished workspace doesn't take the
  //   // evidence with it. Default: `${XDG_STATE_HOME:-~/.local/state}/groundcrew/groundcrew.log`.
  //   file: "~/Library/Logs/groundcrew/groundcrew.log",
  // },
} satisfies Config;
