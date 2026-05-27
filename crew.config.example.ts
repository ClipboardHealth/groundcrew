import type { Config } from "@clipboard-health/groundcrew";
// import { readFileSync } from "node:fs";

export default {
  // Groundcrew's built-in Linear adapter is implicit and needs no config:
  // it picks up every Linear issue assigned to your API key's viewer that
  // carries an `agent-*` label. There is no project / view / status
  // block — Linear's workflow `state.type` (`unstarted` → todo,
  // `started` → in progress, `completed`/`canceled`/`duplicate` →
  // terminal) is the single source of truth, so renamed columns Just Work.
  //
  // Opt a ticket in: assign it to yourself and add an `agent-<model>`
  // label (e.g. `agent-claude`, `agent-any`).
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
  // // Linear adapter. The most common use is `kind: "shell"`, which wires
  // // any external system via command templates that emit/consume JSON.
  // // See the shell adapter's ShellIssue schema for the JSON contract
  // // `fetch` / `resolveOne` must emit.
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
  //     // Optional: mint a short-lived credential outside Safehouse and
  //     // forward it into the agent. `preLaunch` runs in the launch shell
  //     // before the agent exec; `preLaunchEnv` lists the names to add to
  //     // groundcrew's `safehouse-clearance --env-pass=` flag so the wrap's
  //     // egress allowlist stays intact. Chain with `&&` so a failed mint
  //     // aborts launch before `export`.
  //     // claude: {
  //     //   preLaunch: "SESSION_TOKEN=$(your-mint-command) && export SESSION_TOKEN",
  //     //   preLaunchEnv: ["SESSION_TOKEN"],
  //     // },
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
