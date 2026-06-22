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
    printf '[]'
    ;;
  *)
    echo "usage: pr-followups.sh {verify|list|get <ID>|reviewed <ID>|complete <ID>}" >&2
    exit 2
    ;;
esac
