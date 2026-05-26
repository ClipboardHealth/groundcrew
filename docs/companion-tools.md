# Companion tools

Optional tools and integrations that go around groundcrew to turn one-shot agent runs into a closed PR-to-merge loop. Nothing here is required — `crew run` works fine without any of it — but each entry removes a manual step from the autonomous workflow.

Sections are ordered as a suggested **install sequence**: earlier items are prerequisites or producers for later items. GitHub-side integrations (rows 1–2 in the TL;DR) are one-time org/repo setup; the rest are per-developer.

## TL;DR

| #   | Tool                                                       | What it does                                                                                                                                                                                                  | Scope               |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | [Linear ↔ GitHub integration](#linear--github-integration) | Auto-links PRs to Linear tickets and transitions ticket status as the PR opens/merges. Without it, `{{ticket}}` placeholders in the sandbox prompt are just decoration.                                       | Org (one-time)      |
| 2   | [CodeRabbit GitHub app](#coderabbit)                       | AI reviewer that posts inline + review-body comments on every PR within minutes. The producer that `babysit-pr` consumes.                                                                                     | Repo/org (one-time) |
| 3   | [CodeRabbit Claude Code plugin](#claude-code-plugin)       | `/coderabbit-review` (local pre-PR review against the working diff) and `coderabbit:autofix` skill (apply CodeRabbit's PR-thread suggestions to your code, with per-change approval).                         | Per developer       |
| 4   | [`core:babysit-pr` skill](#babysit-pr)                     | Drives one PR forward per pass: auto-fixes high-confidence CI failures (lint, format, typecheck), replies to active review threads, and summarises CodeRabbit's review-body findings. Never resolves threads. | Per developer       |
| 5   | [superpowers Claude Code plugin](#superpowers)             | Process-skill library (TDD, debugging, brainstorming, sub-agent code review, planning). Step 0 of the sandbox prompt invokes `superpowers:using-superpowers` — without the plugin that step silently no-ops.  | Per developer       |
| 6   | [codexbar](#codexbar)                                      | macOS menu-bar app that tracks Claude/Codex session usage. Lets groundcrew gate dispatch on `orchestrator.sessionLimitPercentage` so it doesn't fire tickets at a model that's already over its cap.          | Per developer       |
| 7   | [Sandbox `prompts.initial`](#sandbox-promptsinitial)       | The initial prompt sent to each sandbox agent — autonomy rules, code-style pointer, end-to-end PR workflow that uses items 1–6 to close its own loop.                                                         | Per developer       |

## Linear ↔ GitHub integration

Add Linear's official GitHub integration to the org or repos your sandboxes push to. Without it, the `{{ticket}}` placeholder in your sandbox prompt's PR title is just decoration; with it, the agent's workflow closes its own loop.

What you get:

- **Automatic ticket linking.** A PR whose title or body references a ticket ID (e.g. `[ABC-123]` in the title or `Closes ABC-123` in the body) is attached to that Linear ticket — no manual link, no copy-paste.
- **Automatic status transitions.** The ticket moves to **In Review** the moment the PR is posted, and to **Done** (or whichever status you map) when it merges.
- **Bidirectional visibility.** PR status (open, reviewed, merged) shows up on the Linear ticket; the ticket appears in the PR sidebar.

### Install

1. In Linear, open **Settings → Integrations → GitHub**.
2. Click **Connect** and authorise the GitHub org(s) you want covered. The integration is org-wide; no per-repo install needed.
3. (Optional) Tune status mappings under the same settings page — which Linear status corresponds to "PR open," "PR merged," "PR closed without merge," etc.

### Sandbox payoff

The [Sandbox `prompts.initial`](#sandbox-promptsinitial) workflow silently depends on this integration:

- Step 4's `[{{ticket}}] <one-line summary>` PR title is the hook the integration uses to find the ticket.
- Step 6's "do not touch the ticket's status" only works because the integration handles transitions for you.

Without the integration, the sandbox finishes work, opens a PR, and the ticket sits in **To Do** until a human moves it — which negates most of the autonomous-loop promise.

## CodeRabbit

CodeRabbit is the AI code reviewer that produces the nitpicks, minor findings, and outside-diff-range comments that [babysit-pr](#babysit-pr) parses. Enabling it on a repo means every PR your sandbox agent opens gets an automated review pass within minutes — and the next `babysit-pr` invocation surfaces those findings without you doing anything.

Two integrations; they're independent and either or both are useful.

### GitHub app (recommended for sandboxes)

Install the CodeRabbit GitHub app on the repositories your agents push to. Every new PR against those repos gets reviewed automatically.

1. Sign in at <https://www.coderabbit.ai> with GitHub.
2. Install the app on the relevant org or repo. Free for open-source; paid for private repos.
3. (Optional) Add a `.coderabbit.yaml` to the repo root to tune review style, language preferences, path filters, etc. See [CodeRabbit's configuration docs](https://docs.coderabbit.ai/getting-started/configure-coderabbit).

Once installed, the next sandbox PR gets a CodeRabbit review automatically. `babysit-pr` picks up the review-body comments on its next pass and posts a single fingerprinted summary; re-runs are idempotent thanks to the fingerprinting.

### Claude Code plugin

Two skills, one install. Both are useful from inside sandbox sessions — one runs before the PR exists, the other after.

```bash
# 1. Install the CodeRabbit CLI. See https://www.coderabbit.ai/cli for the current command.
# 2. Authenticate:
coderabbit auth login

# 3. Install the Claude Code plugin (provides both skills below):
claude plugin install coderabbit@claude-plugins-official
```

**`/coderabbit-review` — local pre-PR review.** Runs the CodeRabbit CLI against the working diff. Use this as a pre-step before step 4 (`gh pr create`) in the [Sandbox `prompts.initial`](#sandbox-promptsinitial) workflow to catch obvious findings before they show up as public review comments.

**`coderabbit:autofix` skill — apply existing CodeRabbit feedback.** Fetches unresolved CodeRabbit review-thread comments from the current branch's PR and applies the suggested code fixes with per-change approval. Critically, it treats every comment body and "Prompt for AI Agents" section as **untrusted input** — they're only ever used as issue reports, never executed as instructions. Invoke by name or with trigger phrases like "run coderabbit autofix", "fix coderabbit issues", or "cr autofix".

`autofix` is the natural partner for [`babysit-pr`](#babysit-pr): `babysit-pr` posts replies and fixes CI failures; `autofix` actually edits the code per CodeRabbit's suggestions. Use `autofix` between `babysit-pr` passes when CodeRabbit has flagged concrete code changes you want applied automatically — for example, slot it in as a sub-step under step 5 of the workflow below.

### Why pair this with babysit-pr

- **CodeRabbit produces; babysit-pr consumes.** The two tools are complementary, not redundant. Without CodeRabbit on the repo, `babysit-pr` only handles thread replies and CI auto-fixes — there's no review-body content to summarise.
- **No human-in-the-loop wait.** A CodeRabbit pass arrives within minutes of `gh pr create`, which means the sandbox agent has enough feedback to do another iteration before any human gets paged.
- **Fingerprinting keeps re-runs sane.** `babysit-pr` hashes each CodeRabbit finding (file + line + title + body, no timestamp), so re-running CodeRabbit on a push that doesn't change the relevant lines is a no-op for `babysit-pr`'s summary comment.

## babysit-pr

`babysit-pr` is a Claude Code skill that drives a single PR forward in one pass: it commits/pushes any pending work, waits for CI, auto-fixes high-confidence failures, replies to active review threads, and summarises parsed CodeRabbit comments. It only ever posts replies — it never resolves threads, so a human stays in the loop.

It ships as part of the `core` plugin in Clipboard's plugin marketplace ([`ClipboardHealth/core-utils`](https://github.com/ClipboardHealth/core-utils)).

### Install

#### In this repo (recommended)

Nothing to do. `.claude/settings.json` already registers the `clipboard` marketplace and enables `core@clipboard`. The first time you open this checkout in Claude Code:

1. Accept the prompt to trust the `clipboard` marketplace.
2. Accept the prompt to enable the `core` plugin.

After that, `/babysit-pr` is available in this project.

#### Globally (or in another repo)

If you want `babysit-pr` outside this repo, register the marketplace and enable the plugin at user scope:

```bash
# Add the marketplace
claude plugin marketplace add github:ClipboardHealth/core-utils

# Enable the core plugin (provides babysit-pr and other skills)
claude plugin install core@clipboard
```

Verify with `claude plugin list` — you should see `core@clipboard` enabled.

### Use

Prerequisites: working tree must be clean (the skill refuses to start with uncommitted changes so it never sweeps up unrelated work), and `gh auth status` must succeed.

Invoke from Claude Code:

```text
/babysit-pr            # operate on the PR for the current branch
/babysit-pr 482        # check out PR #482 first, then babysit it
/babysit-pr https://github.com/ClipboardHealth/groundcrew/pull/482
```

Each invocation runs **exactly one pass**. To keep babysitting on a cadence, wrap it in `/loop`:

```text
/loop 5m /babysit-pr
```

…or in an external shell loop if you're driving Claude Code headlessly.

### What to expect

- **Replies** are posted as new comments on each active thread, ending with an HTML-comment sentinel (`<!-- babysit-pr:addressed v1 core@<version> -->`). The sentinel is how subsequent runs know which threads they've already handled, so re-runs are idempotent.
- **CodeRabbit review-body comments** (Nitpicks, Minor, Outside-diff-range) get a single fingerprinted summary comment rather than one reply per finding. Requires the [CodeRabbit GitHub app](#coderabbit) to be installed on the repo.
- **Deferred items** carry a second sentinel (`babysit-pr:followup`) so you can grep them later: `gh pr view <n> --json comments | jq '...' | grep babysit-pr:followup`.
- **Threads are never resolved** by the skill. A human decides when something is actually done.

### Read more

- Skill source (canonical reference): [`core-utils/plugins/core/skills/babysit-pr/SKILL.md`](https://github.com/ClipboardHealth/core-utils/tree/main/plugins/core/skills/babysit-pr)
- Companion `/loop` skill for recurring invocation: shipped with Claude Code's default skill set.

## superpowers

The `superpowers` Claude Code plugin ships a library of process skills — TDD, debugging, brainstorming, code review, sub-agent dispatch, planning, and verification — designed to give Claude Code a more disciplined working loop than the bare default. The [Sandbox `prompts.initial`](#sandbox-promptsinitial) workflow below conditionally invokes `superpowers:using-superpowers` as its first step; installing the plugin is what turns that step from a no-op into actual behaviour.

Maintained at <https://github.com/obra/superpowers>; distributed through Anthropic's official marketplace.

### Install

```bash
claude plugin install superpowers@claude-plugins-official
```

`claude-plugins-official` is pre-registered with Claude Code, so no separate `claude plugin marketplace add` is required. Verify with `claude plugin list` — you should see `superpowers@claude-plugins-official` enabled.

### Skills you actually use in a sandbox

A handful of `superpowers:*` skills, invoked either by name (e.g. `superpowers:tdd`) or via trigger phrases declared in each skill's metadata. The ones the sandbox prompt's workflow leans on:

- **`using-superpowers`** — entry point; teaches the agent how to find and invoke the rest of the suite. The sandbox prompt invokes this first.
- **`brainstorming`** — required before creative work; explores intent and design before code.
- **`writing-plans`** — turns a spec into a written implementation plan.
- **`test-driven-development`** — strict red-green-refactor with verification.
- **`systematic-debugging`** — disciplined reproduce → minimise → hypothesise → instrument → fix loop.
- **`subagent-driven-development`** — guidance for executing plans across independent subagents (pairs with step 3 of the workflow below).
- **`requesting-code-review`** — formal version of "spawn a sub-agent to review the diff" (also pairs with step 3).
- **`verification-before-completion`** — requires running and reading verification commands before claiming work is done.
- **`using-git-worktrees`** — preferred isolation pattern, which is exactly what groundcrew already does per-ticket.

### Why install it for sandbox use

- **The sandbox prompt assumes it.** Step 0 of the [workflow](#sandbox-promptsinitial) is `invoke superpowers:using-superpowers`. Without the plugin the agent silently no-ops that step and loses the discipline the rest of the prompt depends on.
- **It composes with `babysit-pr`.** Superpowers covers the _pre-PR_ loop (planning, TDD, self-review); `babysit-pr` covers the _post-PR_ loop (replies, CI fixes, CodeRabbit summary). The sandbox prompt threads them together end-to-end.
- **The skills are opinionated, not generic.** Each one carries red-flag lists and refusal patterns that resist the model's drift toward "let me just stub this and ask you to fill it in," which is the failure mode the prompt's `## Autonomy` block also targets — they reinforce each other.

## codexbar

`codexbar` is a macOS menu-bar app that tracks Claude and Codex session usage. Groundcrew integrates with it via `orchestrator.sessionLimitPercentage` (default `85`): a model whose codexbar session window exceeds that percentage is skipped for the current dispatch tick. Without codexbar installed, groundcrew can keep dispatching tickets at a model that's already burned its session budget — those runs fail immediately on session limits and waste a worktree provision each time.

Homepage: <https://codexbar.app/>.

### Install (macOS only)

```bash
brew install --cask codexbar
```

Then launch the app from `/Applications` (or `open -a CodexBar`) and sign in to Claude and/or Codex. Requires macOS 14+ on Apple Silicon.

On Linux/WSL, codexbar is unavailable. Set `usage: { disabled: true }` on each model that would otherwise be gated — see "Opt out" below — to silence `crew doctor`'s "codexbar — required for usage gating" warning.

### Use

Once installed, groundcrew picks codexbar up automatically: the shipped `claude` and `codex` model definitions already carry `usage: { codexbar: { provider: ... } }` blocks ([`src/lib/config.ts:290,295`](../src/lib/config.ts)), so no `crew.config.ts` change is needed.

```bash
codexbar usage          # current session windows per provider
crew doctor             # groundcrew reports the gating check explicitly
```

To tune gating, set `orchestrator.sessionLimitPercentage` in `crew.config.ts` (default `85` skips a model when it crosses 85% of its session window). To opt a specific model out, set `models.definitions.<name>.usage = { disabled: true }` — useful on Linux/WSL or for a model where you'd rather let failures surface than gate dispatch.

### Why bother for sandbox use

- **Avoids wasted worktree provisions.** A model already over its session cap will fail every ticket dispatched to it, but each failure still spends a worktree + setup pass. Gating skips the dispatch entirely so `orchestrator.maximumInProgress` stays useful for capacity that can actually do work.
- **Pairs with `agent-any` failover.** When the primary model is capped, an `agent-any` ticket routes to whichever model still has session capacity, instead of stalling against the cap.
- **Visible state.** The menu-bar UI is the fastest way to see _why_ a model isn't picking up tickets right now — useful when `crew doctor` reports an in-flight model as gated.

## Sandbox `prompts.initial`

Groundcrew sends the agent in each sandbox a single initial prompt, configured at `prompts.initial` in your `crew.config.ts`. The shipped default (see `DEFAULT_PROMPT_INITIAL` in `src/lib/config.ts`) is intentionally minimal — enough to get an agent through a ticket, but not opinionated about _how_.

The prompt below is a more opinionated drop-in: it locks the agent into autonomous mode, dictates a code style that holds up under repeated AI editing, and ends each ticket with a sub-agent self-review plus a bounded `core:babysit-pr` pass on the resulting PR.

Available placeholders (validated by `ALLOWED_PROMPT_PLACEHOLDERS`): `{{ticket}}`, `{{title}}`, `{{worktree}}`, `{{description}}`.

### Install

Edit your groundcrew config — typically `~/.config/groundcrew/crew.config.ts`, but anywhere in the [cosmiconfig search path](https://github.com/cosmiconfig/cosmiconfig) (e.g. `crew.config.ts` in a repo root) works:

```bash
$EDITOR ~/.config/groundcrew/crew.config.ts
```

Add (or replace) the `prompts.initial` field:

```ts
import type { Config } from "@clipboard-health/groundcrew";

export default {
  // ... your other config ...
  prompts: {
    initial: [
      "You are working on Linear ticket {{ticket}} ({{title}}) in the {{worktree}} worktree subdirectory.",
      // ... rest of the prompt below, joined with "\n" ...
    ].join("\n"),
  },
} satisfies Config;
```

Groundcrew validates the prompt on load — unknown `{{...}}` placeholders fail fast at startup, so you'll catch typos immediately.

### Suggested content

```text
You are working on Linear ticket {{ticket}} ({{title}}) in the {{worktree}} worktree subdirectory.

## Autonomy

Make every design and implementation decision yourself. Do not stop to ask clarifying questions — there is no human watching this session.

**No exceptions:**

- Not for "fundamental" or "architectural" decisions
- Not for "I just need one quick clarification"
- Not when the ticket description is empty or incomplete (proceed from the title)
- Not "in the spirit of being efficient"

**Violating the letter of this rule is violating the spirit of this rule.**

When the ticket is ambiguous:

1. Pick the simplest interpretation consistent with the ticket and the codebase's existing patterns.
2. Proceed and finish the work.
3. Record the choice (and the alternatives you considered) in the PR description under a "Decisions" section, so the reviewer can push back if you guessed wrong.

## Code style

Follow this project's coding conventions. Before editing, look for `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or a `.rules/` directory at the repo root and apply whatever rules they encode to anything you add or change. When conventions conflict, the more specific file wins (a `.rules/<area>.md` beats `AGENTS.md`, which beats `CLAUDE.md`).

<!-- Or paste your own org-wide coding conventions here, in place of the paragraph above, if you want them enforced in every sandbox regardless of which repo. -->

## Workflow

If the `superpowers` plugin is installed, invoke the `superpowers:using-superpowers` skill before you do anything else — it is the entry point to a suite (brainstorming, writing-plans, test-driven-development, systematic-debugging, subagent-driven-development, verification-before-completion, requesting-code-review, finishing-a-development-branch) that you should apply throughout this task as the situation calls for it. The numbered steps below describe the destination; superpowers describes the discipline that gets you there.

1. Implement the change.
2. Run the project's unit tests. If any fail, fix them before continuing. Pre-existing failures, "unrelated" failures, and flaky failures all count — diagnose the root cause and either fix or document in the Decisions section. Never skip a test, disable it (e.g. `it.skip`), or rely on CI to catch what should pass locally.
3. Spawn a sub-agent to review your changes before opening the PR. Hand it the diff plus the ticket description, but not your reasoning or this conversation — the value is in independent judgment. Ask it to flag bugs, regressions, missing test coverage, security issues, and convention violations. Fix every issue found, then re-run steps 2 and 3 on the updated diff; iterate until tests pass and the review surfaces no remaining substantive findings. "Same findings as last iteration" is **not** convergence — it means your fixes were incomplete; fix harder. Document any disagreement with a specific finding in the PR's Decisions section.
4. Open a pull request (e.g. `gh pr create`). Match the PR title to your team's ticket-linking convention — for Linear's GitHub integration that is `[{{ticket}}] <one-line summary>`. Include `Closes {{ticket}}` in the body if your tracker uses it. Include a short continuation note when you know how to reattach to this workspace — for the tmux backend that is `tmux attach -t groundcrew:{{ticket}}`; for the cmux backend, instruct the reviewer to open the cmux app and select the `{{ticket}}` workspace. Do not append a "Generated with Claude Code" footer or any "Co-Authored-By: Claude" trailer to the PR body.
5. If the `core:babysit-pr` skill is installed (see the [babysit-pr](#babysit-pr) section above), invoke it on the PR you just opened. It snapshots the current CI state, auto-fixes high-confidence failures (lint, format, typecheck, missing imports), replies to active review threads, and summarizes CodeRabbit's review-body comments — it does **not** wait internally for CI to complete; if CI is still running it will exit "progressing" and you must come back later. Address every issue it surfaces — push fixes back through steps 2–3 (tests + sub-agent review) before re-invoking. Run `core:babysit-pr` up to 3 times total. Wait at least 10 minutes between invocations so CodeRabbit has time to post its review and CI has time to settle. Stop earlier if a pass produces no new fixes or pushes no new commits.
6. Stop. The human review loop happens out-of-session — do not keep polling the PR, do not re-invoke `core:babysit-pr` beyond the bounded retries above, and do not refresh CI by hand. Do not touch the ticket's status in your tracker; an integration handles status transitions when the PR opens and merges (the PR title format from step 4 is what lets the integration find the ticket).

## Ticket

{{description}}
```

### Why this shape

- **Autonomy block first.** Without it, agents waste sandbox time waiting for a human to answer "should I…?" The explicit "no exceptions" list closes the loopholes models otherwise find ("but this is fundamental"). The "record the choice in a Decisions section" escape valve keeps human oversight intact without blocking forward motion.
- **Code style by reference, not by value.** The prompt points the agent at the repo's own conventions (`AGENTS.md`, `CLAUDE.md`, `.rules/`) rather than baking in language-specific rules. That keeps the prompt portable across Python, TypeScript, Go, etc., and means coding rules get version-controlled alongside the code they govern instead of duplicated in a personal config.
- **Bounded `core:babysit-pr` invocations.** Three passes with 10-minute gaps lets CodeRabbit and CI settle without the agent burning the sandbox in a tight polling loop. The "stop earlier if no new fixes" clause prevents wasted passes on already-quiet PRs.
- **PR title format is convention, not law.** The original Clipboard prompt requires `[{{ticket}}] <title>` because that's how the Linear↔GitHub integration auto-transitions tickets. If your tracker uses a different convention, swap the format and the integration note in step 4 — keep the `{{ticket}}` placeholder so the link survives.
- **`{{description}}` lives at the bottom.** Placing it after the rules means the ticket content (whatever its tone) doesn't drown out the discipline above it. Models weight the _most recent_ instructions heaviest; ending on the ticket keeps the actual work in focus.
