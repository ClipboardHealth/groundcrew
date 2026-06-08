import type { Config } from "@clipboard-health/groundcrew";
// import { readFileSync } from "node:fs";

export default {
  // Groundcrew's built-in Linear adapter is implicit and needs no config:
  // it picks up every Linear issue assigned to your API key's viewer that
  // carries an `agent-*` label. There is no project / view block. The default
  // Linear status names `In Progress` and `In Review` disambiguate Linear's
  // `started` workflow states; other statuses fall back to workflow
  // `state.type` (`unstarted` → todo, `started` → in progress,
  // `completed`/`canceled`/`duplicate` → terminal).
  //
  // Opt a task in: assign it to yourself and add an `agent-<model>`
  // label (e.g. `agent-claude`, `agent-any`).
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
  },
  models: {
    default: "claude",
    // `definitions` is the enabled model set. Built-in keys can use `{}` to
    // opt into the shipped command/color/usage preset. Add `codex: {}` if you
    // want both shipped agents, or add a custom entry and tag tasks with
    // `agent-<name>`.
    definitions: {
      claude: {},
      // codex: {},
      // cursor: {
      //   cmd: "cursor-agent",
      //   color: "#929292",
      // },
    },
  },
  // Repo-preparation hook: runs after each worktree is created and before the
  // agent launches. The default below is a no-op placeholder. Replace it with
  // your repo's setup, e.g. "npm ci" or "uv sync --dev --frozen". A repo-local
  // `.groundcrew/config.json` hooks.prepareWorktree overrides this per repo.
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
  // // `fetch` / `resolveOne` must emit.
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
  //     commands: {
  //       verify: "jira me",
  //       fetch: "~/.config/groundcrew/jira-fetch.sh",
  //       resolveOne: "~/.config/groundcrew/jira-resolve.sh ${id}",
  //       markInProgress: "jira issue move ${id} 'In Progress'",
  //     },
  //     timeouts: { fetch: 60_000 },
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
  //   // Required for this model when `local.runner` resolves to `sdx`.
  //   sandbox: { agent: "claude" },
  // },
  //
  // // Local isolation backend. Defaults to `"auto"` — macOS → safehouse,
  // // Linux → sdx (Docker Sandboxes). `"none"` is an explicit unsandboxed
  // // escape hatch and is never picked implicitly. Switch to `"sdx"` on
  // // macOS when you need an agent to use Docker safely.
  // local: { runner: "auto" },
  //
  // // Groundcrew does not create or authenticate sdx sandboxes. For an sdx
  // // model, create the matching sandbox yourself before first launch:
  // //   sbx create --name groundcrew-claude claude ~/dev/groundcrew
  // //   sbx exec -it groundcrew-claude claude auth login
  // //   sbx exec -it groundcrew-claude gh auth login
  //
  // prompts: {
  //   // Keep personal workflow instructions next to this config, for example
  //   // `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/initial-prompt.md`.
  //   // If you uncomment this, also uncomment the readFileSync import above.
  //   initial: readFileSync(new URL("./initial-prompt.md", import.meta.url), "utf8"),
  // },
  //
  // // Terminal session manager. "auto" picks cmux when on PATH, else tmux.
  // // Set explicitly to "cmux" or "tmux" to fail loudly when the chosen
  // // backend is missing. tmux windows live in a dedicated `groundcrew`
  // // session and lose status-pill painting (cmux-only feature).
  // workspaceKind: "auto",
  //
  // logging: {
  //   // Append-mode log file destination. `log()` / `logEvent()` tee here
  //   // in addition to stdout, so a vanished workspace doesn't take the
  //   // evidence with it. Default: `${XDG_STATE_HOME:-~/.local/state}/groundcrew/groundcrew.log`.
  //   file: "~/Library/Logs/groundcrew/groundcrew.log",
  // },
} satisfies Config;
