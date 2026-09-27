#!/usr/bin/env bash
#
# GitHub Issues <-> groundcrew shell source (single file).
# The shell adapter's commands.* point at one of these subcommands:
#   github.sh verify           gh auth check                     (commands.verify)
#   github.sh list             ShellIssue[] JSON on stdout       (commands.listTasks)
#   github.sh get <ID>         one ShellIssue, exit 3 if absent  (commands.getTask)
#   github.sh move <ID> <STATE> relabel/close the issue          (markInProgress/InReview/Done)
#
# Requires the GitHub CLI (`gh`, authenticated via `gh auth login`) and `jq`.
# Auth is gh's own; this script stores no token.
#
# Task ids encode the issue's repository so `get`/`move` need no lookup table:
#   <owner>__<repo>-<number>   e.g. ClipboardHealth/groundcrew#412 -> clipboardhealth__groundcrew-412
# (`/` and `#` are not safe in worktree paths or branch names; GitHub owners
# cannot contain `_`, so the first `__` always splits owner from repo.)
#
# GitHub issues are only open/closed, so the in-flight states live in labels:
#   open, no status label        -> todo
#   open + GITHUB_IN_PROGRESS_LABEL -> in-progress
#   open + GITHUB_IN_REVIEW_LABEL   -> in-review   (wins over in-progress)
#   closed (any reason)          -> done
#
# Knobs (set via the source's `env` block in crew.config):
#   GITHUB_GROUNDCREW_QUERY    search qualifiers for `list` (default: label:groundcrew assignee:@me)
#   GITHUB_DEFAULT_AGENT       agent when an issue has no agent:<x> label (default: empty -> null)
#   GITHUB_IN_PROGRESS_LABEL   label marking in-progress (default: groundcrew:in-progress)
#   GITHUB_IN_REVIEW_LABEL     label marking in-review   (default: groundcrew:in-review)
set -euo pipefail

QUERY="${GITHUB_GROUNDCREW_QUERY:-label:groundcrew assignee:@me}"
DEFAULT_AGENT="${GITHUB_DEFAULT_AGENT:-}"
IN_PROGRESS_LABEL="${GITHUB_IN_PROGRESS_LABEL:-groundcrew:in-progress}"
IN_REVIEW_LABEL="${GITHUB_IN_REVIEW_LABEL:-groundcrew:in-review}"
VIEW_FIELDS="number,title,body,state,labels,assignees,updatedAt,url,comments"

# Reshape one `gh issue view --json` object -> one groundcrew ShellIssue. Shared
# by list & get so the two code paths can never drift. The repository comes from
# the issue URL, so it is always set; `agent:<name>` labels pick the agent.
# `read -d ''` returns 1 at EOF; `|| true` keeps that from tripping `set -e`.
read -r -d '' JQ_TRANSFORM <<'JQ' || true
def labelNames: [(.labels // [])[].name];
def canonStatus($ip; $ir):
  if (.state // "") == "CLOSED" then "done"
  elif (labelNames | index($ir)) != null then "in-review"
  elif (labelNames | index($ip)) != null then "in-progress"
  else "todo" end;
# groundcrew feeds `description` to the agent as its prompt and ShellIssue has
# no comments field, so the discussion is folded in here, oldest first.
def commentsText:
  ((.comments // [])
   | map("[" + (.author.login // "unknown")
         + (if (.createdAt // "") == "" then "" else " (" + .createdAt + ")" end)
         + "]\n" + (.body // ""))
   | join("\n\n"));
def toShellIssue($ip; $ir; $da):
  (.url | capture("^https://[^/]+/(?<o>[^/]+)/(?<r>[^/]+)/issues/")) as $m
  | ($m.o + "/" + $m.r) as $repo
  | (labelNames | map(select(startswith("agent:"))) | .[0] // null
     | if . == null then (if $da == "" then null else $da end) else ltrimstr("agent:") end) as $agent
  | (.body // "") as $body
  | commentsText as $comments
  | ([ (if $body == "" then empty else $body end),
       (if $comments == "" then empty else "--- Comments ---\n\n" + $comments end) ] | join("\n\n")) as $content
  | ("Repository: " + $repo + "\nIssue: " + .url) as $hdr
  | { id: ($m.o + "__" + $m.r + "-" + (.number | tostring)),
      title: (.title // ("#" + (.number | tostring))),
      description: (if $content == "" then $hdr else $hdr + "\n\n" + $content end),
      status: canonStatus($ip; $ir),
      repository: $repo,
      agent: $agent,
      assignee: ((.assignees // [])[0].login // "Unassigned"),
      updatedAt: (.updatedAt // ""),
      blockers: [],
      hasMoreBlockers: false,
      url: .url,
      sourceRef: { repository: $repo, number: .number } };
JQ

transform() {
  jq "$@" --arg ip "${IN_PROGRESS_LABEL}" --arg ir "${IN_REVIEW_LABEL}" --arg da "${DEFAULT_AGENT}"
}

# Split <owner>__<repo>-<number> into REPO ("owner/repo") and NUMBER.
parse_id() {
  if [[ ! "$1" =~ ^([^_]+)__(.+)-([0-9]+)$ ]]; then
    echo "github.sh: malformed task id '$1' (expected <owner>__<repo>-<number>)" >&2
    exit 2
  fi
  REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  NUMBER="${BASH_REMATCH[3]}"
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  verify)
    gh auth status >/dev/null
    ;;
  list)
    # Open issues plus those closed in the last 7 days: groundcrew only tears
    # down a task's worktree once `list`/`get` report it `done`, so dropping
    # closed issues immediately would leak worktrees. The window lets cleanup
    # happen, then the issue falls out so the steady-state list stays small.
    since="$(jq -rn 'now - 7 * 86400 | strftime("%Y-%m-%d")')"
    # `gh search issues` returns issues only (never PRs) and prints `[]` with
    # exit 0 for no matches, so a failed search here is a real error.
    # Two assignments, not one substitution, so either search failing exits.
    open_urls="$(gh search issues "${QUERY}" --state open --limit 50 --json url --jq '.[].url')"
    closed_urls="$(gh search issues "${QUERY}" --state closed --closed ">=${since}" --limit 50 --json url --jq '.[].url')"
    # Enrich each hit with its comments (search results omit them): 2 searches
    # + 1 `view` per issue. A failed `view` logs and skips that one issue.
    printf '%s\n' "${open_urls}" "${closed_urls}" \
      | while IFS= read -r url; do
          [[ -n "${url}" ]] || continue
          gh issue view "${url}" --json "${VIEW_FIELDS}" 2>/dev/null \
            || { echo "github.sh list: skipping ${url} (view failed)" >&2; continue; }
        done \
      | transform -s -c "${JQ_TRANSFORM} [ .[] | toShellIssue(\$ip; \$ir; \$da) ]"
    ;;
  get)
    parse_id "${1:?usage: github.sh get <ID>}"
    get_err="$(mktemp)"
    trap 'rm -f "${get_err}"' EXIT
    if ! out="$(gh issue view "${NUMBER}" -R "${REPO}" --json "${VIEW_FIELDS}" 2>"${get_err}")"; then
      # gh exits non-zero for a missing issue/repo AND for transient auth/network
      # failures. Only the former is the not-found sentinel (exit 3); surface the
      # rest as retryable so groundcrew does not treat a live task as vanished.
      if grep -q "Could not resolve to" "${get_err}"; then
        exit 3
      fi
      cat "${get_err}" >&2
      exit 1
    fi
    # `gh issue view` also resolves pull request numbers; a PR is not a task.
    if [[ "$(jq -r '.url' <<<"${out}")" == */pull/* ]]; then
      exit 3
    fi
    transform -c "${JQ_TRANSFORM} toShellIssue(\$ip; \$ir; \$da)" <<<"${out}"
    ;;
  move)
    parse_id "${1:?usage: github.sh move <ID> <STATE>}"
    state="${2:?missing STATE (in-progress|in-review|done)}"
    case "${state}" in
      in-progress) add="${IN_PROGRESS_LABEL}"; remove=("${IN_REVIEW_LABEL}") ;;
      in-review) add="${IN_REVIEW_LABEL}"; remove=("${IN_PROGRESS_LABEL}") ;;
      done) add=""; remove=("${IN_PROGRESS_LABEL}" "${IN_REVIEW_LABEL}") ;;
      *)
        echo "github.sh move: unknown state '${state}' (expected in-progress|in-review|done)" >&2
        exit 2
        ;;
    esac
    # `gh issue edit` fails on a label the repo lacks, so only remove labels the
    # issue carries and create the added label on first use.
    current="$(gh issue view "${NUMBER}" -R "${REPO}" --json labels --jq '.labels[].name')"
    edit_args=()
    for label in "${remove[@]}"; do
      if grep -qxF -- "${label}" <<<"${current}"; then
        edit_args+=(--remove-label "${label}")
      fi
    done
    if [[ -n "${add}" ]]; then
      # Fails when the label already exists; a real failure resurfaces in the edit.
      gh label create "${add}" -R "${REPO}" >/dev/null 2>&1 || true
      edit_args+=(--add-label "${add}")
    fi
    if [[ ${#edit_args[@]} -gt 0 ]]; then
      gh issue edit "${NUMBER}" -R "${REPO}" "${edit_args[@]}" >/dev/null
    fi
    if [[ "${state}" == "done" ]]; then
      # Already-closed issues (e.g. auto-closed by a merged "Fixes #N" PR) are a
      # no-op: gh warns on stderr and exits 0.
      gh issue close "${NUMBER}" -R "${REPO}" >/dev/null
    fi
    ;;
  *)
    echo "usage: github.sh {verify|list|get <ID>|move <ID> <STATE>}" >&2
    exit 2
    ;;
esac
