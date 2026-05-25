import type { Config } from "@clipboard-health/groundcrew";
// import { readFileSync } from "node:fs";

export default {
  linear: {
    // One or more Linear projects to watch. A single `crew` process
    // dispatches across all configured projects under a shared
    // `orchestrator.maximumInProgress` budget.
    //
    // Each entry's `projectSlug` is the trailing segment of your Linear
    // project URL — copy it verbatim, e.g. "ai-strategy-5152195762f3"
    // from "https://linear.app/<workspace>/project/ai-strategy-5152195762f3".
    // The 12-char hex tail is the canonical ID groundcrew uses, so the
    // orchestrator stays resilient across project renames and across
    // same-name projects in different teams. The leading name segment
    // keeps the file self-documenting at a glance.
    //
    // `statuses` is per-project so multi-team setups with divergent
    // workflow state names (e.g. "Todo" vs "To Do", "Shipped" vs
    // "Done") can coexist. Each field falls back to its default when
    // omitted: { todo: "Todo", inProgress: "In Progress",
    // done: "Done", terminal: ["Done"] }.
    projects: [
      { projectSlug: "your-project-name-0123456789ab" },
      // {
      //   projectSlug: "platform-aaaaaaaaaaaa",
      //   statuses: { inProgress: "Doing", done: "Released", terminal: ["Released", "Won't Do"] },
      // },
    ],
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
  // // Additional pluggable ticket sources beyond the implicit built-in
  // // Linear adapter (configured via `linear.projects` above). The most
  // // common use is `kind: "shell"`, which wires any external system via
  // // command templates that emit/consume JSON. See the shell adapter's
  // // ShellIssue schema for the JSON contract `fetch` / `resolveOne` must
  // // emit.
  // sources: [
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
  //   // Shared across all watched projects in linear.projects.
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
  // // Additional auth recipes for `crew sandbox auth <model> <tool>`. The
  // // shipped recipes (claude/codex/cursor agents + github tool) are merged
  // // with whatever you declare here; your recipe wins on key collision.
  // // Describe each tool's in-sandbox login + status commands and a regex
  // // that matches its logged-in output. Omit `kind` for cross-cutting
  // // tools that should appear in every sandbox's picker; set
  // // `kind: "agent"` to scope a recipe to a single sbx agent.
  // sandbox: {
  //   authRecipes: {
  //     gcloud: {
  //       displayName: "gcloud",
  //       binary: "gcloud",
  //       loginArgs: ["auth", "login", "--no-launch-browser"],
  //       statusArgs: ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
  //       authenticatedPattern: /@/,
  //     },
  //   },
  // },
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
