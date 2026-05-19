import type { Config } from "./src/lib/config.js";

export const config: Config = {
  linear: {
    // Project URL slug to scope polling. Copy the trailing segment of
    // your Linear project URL —
    //   https://linear.app/<workspace>/project/<projectSlug>
    // — verbatim, for example "ai-strategy-5152195762f3". The 12-char hex
    // tail is the canonical ID groundcrew uses, so the orchestrator stays
    // resilient across project renames and across same-name projects in
    // different teams. The leading name segment keeps `config.ts`
    // self-documenting at a glance.
    projectSlug: "your-project-name-0123456789ab",
    // statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
  },
  workspace: {
    // Parent directory under which groundcrew clones repositories and
    // creates per-ticket worktrees.
    projectDir: "~/dev/groundcrew",
    // Repositories groundcrew is allowed to set up worktrees in. Add
    // `<owner>/<repo>` or bare `<repo>` entries; the orchestrator scopes
    // tickets to these and refuses unknown repos by default.
    knownRepositories: ["your-org/your-repo"],
  },
  // Everything below is optional — defaults shown for reference. Uncomment
  // and edit to override.
  //
  // git: { remote: "origin", defaultBranch: "main" },
  //
  // orchestrator: {
  //   maximumInProgress: 4,
  //   pollIntervalMilliseconds: 120_000,
  //   sessionLimitPercentage: 85,
  // },
  //
  // models: {
  //   default: "claude",
  //   // Additive: defaults for `claude` and `codex` are merged in unless you
  //   // re-declare those keys here. Add a third agent (e.g. `cursor`) by
  //   // dropping it in this map and tagging tickets with `agent-cursor`.
  //   // Groundcrew runs agent commands through Safehouse/clearance unless already Safehouse-wrapped.
  //   definitions: {
  //     cursor: {
  //       cmd: "cursor-agent",
  //       color: "#929292",
  //     },
  //   },
  // },
  //
  // prompts: {
  //   initial: [
  //     "Begin work on {{ticket}} ({{title}}) in the {{worktree}} wt subdirectory.",
  //     "",
  //     "Ticket description:",
  //     "",
  //     "{{description}}",
  //   ].join("\n"),
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
};
