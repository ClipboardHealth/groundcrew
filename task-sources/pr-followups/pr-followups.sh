#!/usr/bin/env bash
#
# pr-followups <-> groundcrew shell source (single file).
# The shell adapter's commands.* point at one of these subcommands:
#   pr-followups.sh verify           gh auth + repo reachability       (commands.verify)
#   pr-followups.sh list             ShellIssue[] JSON on stdout       (commands.listTasks)
#   pr-followups.sh get <ID>         one ShellIssue, exit 3 if absent  (commands.getTask)
#   pr-followups.sh reviewed <ID>    record PR as handled (PR opened)  (commands.markInReview)
#   pr-followups.sh complete <ID>    record PR as handled (no-op/merged)(commands.markDone)
#
# Requires the `gh` CLI (https://cli.github.com) and `jq`. Read-only on GitHub:
# all progress state lives in a local JSON file per repo, so contributors without
# push access to the upstream repo can run it.
#
# Knobs (set via the source's `env` block in crew.config / source.json):
#   PR_FOLLOWUPS_REPO         "owner/name" (default: derived via `gh repo view`)
#   PR_FOLLOWUPS_BASE         base branch merges are watched on (default: main)
#   PR_FOLLOWUPS_BRANCH_GLOB  followup branch glob, loop guard (default: gc-followup/*)
#   PR_FOLLOWUPS_AGENT        agent for emitted tasks (default: empty -> null)
#   PR_FOLLOWUPS_STATE_DIR    state dir (default: ~/.config/groundcrew/pr-followups-state)
set -euo pipefail

BASE="${PR_FOLLOWUPS_BASE:-main}"
BRANCH_GLOB="${PR_FOLLOWUPS_BRANCH_GLOB:-gc-followup/*}"
# Loop-guard prefix: the glob with a single trailing "*" removed.
BRANCH_PREFIX="${BRANCH_GLOB%\*}"
AGENT="${PR_FOLLOWUPS_AGENT:-}"
STATE_DIR="${PR_FOLLOWUPS_STATE_DIR:-${HOME}/.config/groundcrew/pr-followups-state}"

# The agent's rubric. This is the "prompt in source config": the agent reads it
# as its task description and decides, per merged PR, whether a followup applies.
read -r -d '' RUBRIC <<'TXT' || true
You are reviewing a merged pull request to decide whether a small, mechanical
followup refactoring is warranted. Consider ONLY these refactorings:

  - Extract a duplicated block introduced by this PR into a shared helper.
  - Replace a magic literal the PR added with a named constant already used nearby.
  - Tighten a type the PR left as `any`/`unknown` when the concrete type is obvious.

If exactly one or more clearly applies, make the smallest sensible change and open
a followup PR on a branch named `gc-followup/<PR_NUMBER>-<short-slug>`. Keep the
diff minimal and focused. If none clearly applies, run `$GROUNDCREW_COMPLETE` and
stop WITHOUT opening a PR. Do not refactor beyond the listed items.
TXT

resolve_repo() {
  if [[ -n "${PR_FOLLOWUPS_REPO:-}" ]]; then
    printf '%s' "${PR_FOLLOWUPS_REPO}"
  else
    gh repo view --json nameWithOwner -q .nameWithOwner
  fi
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ${STATE_DIR}/<owner>__<name>.json for "owner/name".
state_path() {
  local repo="$1"
  printf '%s/%s.json' "${STATE_DIR}" "${repo//\//__}"
}

ensure_state() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    mkdir -p "$(dirname "${file}")"
    jq -n --arg floor "$(now_iso)" '{floor: $floor, handled: []}' > "${file}"
  fi
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  verify)
    gh auth status >/dev/null 2>&1
    gh repo view "$(resolve_repo)" --json nameWithOwner >/dev/null
    ;;
  list)
    repo="$(resolve_repo)"
    state_file="$(state_path "${repo}")"
    ensure_state "${state_file}"
    floor="$(jq -r '.floor' "${state_file}")"
    handled="$(jq -c '.handled' "${state_file}")"

    # Read-only query: merged PRs into BASE. Over-fetch by date (search has no
    # reliable sub-day granularity for the `merged:` qualifier across formats),
    # then apply the precise `mergedAt > floor` filter in jq below.
    prs="$(gh pr list --repo "${repo}" --state merged --base "${BASE}" \
            --search "merged:>=${floor%%T*}" --limit 200 \
            --json number,title,mergedAt,headRefName,body,author)"

    printf '%s' "${prs}" | jq -c \
      --arg floor "${floor}" \
      --argjson handled "${handled}" \
      --arg prefix "${BRANCH_PREFIX}" \
      --arg repo "${repo}" \
      --arg agent "${AGENT}" \
      --arg rubric "${RUBRIC}" '
      [ .[]
        | select(.mergedAt > $floor)
        | select((.headRefName | startswith($prefix)) | not)
        | . as $pr
        | select(([$handled[] | tostring] | index($pr.number | tostring)) == null)
        | {
            id: ("followup-" + ($pr.number | tostring)),
            title: ("Refactor followup for #" + ($pr.number | tostring) + ": " + $pr.title),
            description: ($rubric
              + "\n\n--- Merged PR ---\n"
              + "Number: #" + ($pr.number | tostring) + "\n"
              + "Title: " + $pr.title + "\n\n"
              + "Body:\n" + ($pr.body // "")
              + "\n\nFetch the full diff with: gh pr diff " + ($pr.number | tostring)
              + " --repo " + $repo),
            status: "todo",
            repository: $repo,
            agent: (if $agent == "" then null else $agent end),
            assignee: ($pr.author.login // "unknown"),
            updatedAt: $pr.mergedAt,
            blockers: [],
            hasMoreBlockers: false,
            url: ("https://github.com/" + $repo + "/pull/" + ($pr.number | tostring)),
            sourceRef: { number: $pr.number }
          }
      ]'

    # Compaction: advance the floor across the oldest-first contiguous run of
    # PRs that need no (further) processing (in `handled` OR followup-branch),
    # then prune from `handled` everything strictly below the new floor. A PR
    # tied exactly at the new floor stays in `handled` so the inclusive boundary
    # cannot re-emit it.
    new_state="$(printf '%s' "${prs}" | jq -c \
      --arg floor "${floor}" \
      --argjson handled "${handled}" \
      --arg prefix "${BRANCH_PREFIX}" '
      ([$handled[] | tostring]) as $hset
      | (sort_by(.mergedAt)) as $sorted
      | (reduce $sorted[] as $pr ({stop:false, floor:$floor};
          if .stop then .
          elif ($pr.headRefName | startswith($prefix)) then .floor = $pr.mergedAt
          elif ($hset | index($pr.number | tostring)) != null then .floor = $pr.mergedAt
          else .stop = true end)
        ).floor as $newfloor
      | {
          floor: $newfloor,
          handled: [ $handled[] as $n
                     | (([$sorted[] | select(.number == $n) | .mergedAt] | first) // null) as $m
                     | select(($m == null) or ($m >= $newfloor))
                     | $n ]
        }')"
    printf '%s' "${new_state}" > "${state_file}"
    ;;
  *)
    echo "usage: pr-followups.sh {verify|list|get <ID>|reviewed <ID>|complete <ID>}" >&2
    exit 2
    ;;
esac
