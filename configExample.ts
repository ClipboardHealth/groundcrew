import type { Config } from "./src/lib/config.js";
// import { readFileSync } from "node:fs";

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
  //     // To run a model under the sdx (Docker Sandboxes) runner, bind it to
  //     // an sbx agent. Required when `local.runner` resolves to `sdx`.
  //     // claude: { sandbox: { agent: "claude" } },
  //   },
  // },
  //
  // // Local isolation backend. Defaults to `"auto"` — macOS → safehouse,
  // // Linux → sdx (Docker Sandboxes). `"none"` is an explicit unsandboxed
  // // escape hatch and is never picked implicitly. Switch to `"sdx"` on
  // // macOS when you need an agent to use Docker safely.
  // local: { runner: "auto" },
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
};
