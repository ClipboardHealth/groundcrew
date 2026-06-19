#!/usr/bin/env bash
#
# JIRA <-> groundcrew shell source (single file).
# The shell adapter's commands.* point at one of these subcommands:
#   jira.sh verify             token + connectivity check        (commands.verify)
#   jira.sh list               ShellIssue[] JSON on stdout       (commands.listTasks)
#   jira.sh get <KEY>          one ShellIssue, exit 3 if absent  (commands.getTask)
#   jira.sh move <KEY> <STATE> transition the issue              (markInProgress/InReview/Done)
#
# Requires the `jira` CLI (https://github.com/ankitpokhrel/jira-cli) and `jq`.
#
# Auth: the API token is read from a gitignored file so it is scoped to this
# source and never global. Set it once:
#   printf '%s' '<token>' > ~/.config/groundcrew/jira.token
#   chmod 600 ~/.config/groundcrew/jira.token
#
# Knobs (set via the source's `env` block in crew.config):
#   JIRA_GROUNDCREW_JQL  JQL for `list`  (default: open + last-7-days-done issues labeled groundcrew; no ORDER BY — see below)
#   JIRA_REVIEW_PATTERN  case-insensitive regex; matching In-Progress status names -> in-review (default: review)
#   JIRA_TODO_PATTERN    case-insensitive regex; matching In-Progress status names -> todo (default: empty -> off)
#   JIRA_DEFAULT_AGENT   agent when an issue has no agent:<x> label (default: empty -> null)
#   JIRA_TOKEN_FILE      token path (default: ~/.config/groundcrew/jira.token)
set -euo pipefail

TOKEN_FILE="${JIRA_TOKEN_FILE:-${HOME}/.config/groundcrew/jira.token}"
# No ORDER BY here: jira-cli appends its own (see --order-by below), and a
# second ORDER BY in the JQL makes JIRA reject the query with a 400.
# The default gates dispatch on an explicit `groundcrew` label so only issues
# you opt in are picked up — see the README's labeling step. It also keeps
# tickets done within the last 7 days in the list: groundcrew only tears down a
# task's worktree once `list`/`get` report it `done`, so dropping done tickets
# immediately would leak worktrees. The 7-day window lets cleanup happen, then
# the ticket falls out so the steady-state list stays small.
LIST_JQL="${JIRA_GROUNDCREW_JQL:-labels = groundcrew AND (statusCategory != Done OR (statusCategory = Done AND updated >= -7d))}"
REVIEW_PATTERN="${JIRA_REVIEW_PATTERN:-review}"
TODO_PATTERN="${JIRA_TODO_PATTERN:-}"
DEFAULT_AGENT="${JIRA_DEFAULT_AGENT:-}"

if [[ -r "${TOKEN_FILE}" ]]; then
  JIRA_API_TOKEN="$(cat "${TOKEN_FILE}")"
  # Trim surrounding whitespace so a token written with `echo`, saved with a
  # trailing newline, CRLF line endings, or stray spaces still authenticates.
  JIRA_API_TOKEN="${JIRA_API_TOKEN#"${JIRA_API_TOKEN%%[![:space:]]*}"}"
  JIRA_API_TOKEN="${JIRA_API_TOKEN%"${JIRA_API_TOKEN##*[![:space:]]}"}"
  # An empty (or whitespace-only) file would export a blank token and surface a
  # cryptic auth failure deep in a `jira` call; reject it up front instead.
  if [[ -z "${JIRA_API_TOKEN}" ]]; then
    echo "jira token file is empty: ${TOKEN_FILE}" >&2
    exit 1
  fi
  export JIRA_API_TOKEN
fi

# Reshape one JIRA REST issue -> one groundcrew ShellIssue. Shared by list & get
# so the two code paths can never drift. Labels carry dispatch metadata:
#   repo:Owner__name -> repository "Owner/name"   (__ decodes to /)
#   agent:<name>     -> agent "<name>"
# `read -d ''` reads until a NUL; the heredoc has none, so `read` consumes the
# whole body but returns 1 at EOF. The `|| true` keeps that expected non-zero
# from tripping `set -e` — JQ_TRANSFORM is still fully populated.
read -r -d '' JQ_TRANSFORM <<'JQ' || true
def adfText: [.. | .text? // empty] | join(" ");
# A rich-text field is either a plain string (REST v2) or an ADF object (v3);
# flatten both to text. Shared by the description and each comment body.
def bodyText: if type == "string" then . elif type == "object" then adfText else "" end;
def labelValue($p):
  ((.fields.labels // []) | map(select(startswith($p))) | .[0] // null)
  | if . == null then null else ltrimstr($p) end;
def browseUrl:
  ((.self // "") | capture("^(?<b>https?://[^/]+)") | .b) as $base
  | if ($base // "") == "" then null else $base + "/browse/" + .key end;
# JIRA has only three status *categories* (new/indeterminate/done) but groundcrew
# needs five canonical states. The indeterminate ("In Progress") category is the
# catch-all for in-flight workflow, so review and todo are recovered from the
# status *name*: a name matching $tp (e.g. "Acknowledged") demotes to todo so
# groundcrew dispatches it as new work; a name matching $rp promotes to in-review.
# $tp is checked first and only when non-empty (an empty regex matches every name).
def canonStatus($rp; $tp):
  (.fields.status.statusCategory.key // "") as $c
  | (.fields.status.name // "") as $n
  | if   $c == "done"          then "done"
    elif $c == "new"           then "todo"
    elif $c == "indeterminate" then
      (if   ($tp != "" and ($n | test($tp; "i"))) then "todo"
       elif ($n | test($rp; "i"))                  then "in-review"
       else "in-progress" end)
    else "other" end;
# Render the issue's comments (oldest first) as one text block, each headed by
# author and timestamp. groundcrew feeds `description` to the agent as its
# prompt, and ShellIssue has no comments field, so the discussion is folded in
# here. NOTE: jira-cli returns only the first page of comments (the REST view
# endpoint paginates), so heavily-commented issues may be truncated.
def commentsText:
  ((.fields.comment.comments // [])
   | map("[" + (.author.displayName // "Unknown")
         + (if (.created // "") == "" then "" else " (" + .created + ")" end)
         + "]\n" + (.body | bodyText))
   | join("\n\n"));
def toShellIssue($rp; $tp; $da):
  (labelValue("repo:")  | if . == null then null else gsub("__"; "/") end) as $repo
  | (labelValue("agent:") // (if $da == "" then null else $da end)) as $agent
  | (.fields.description | bodyText) as $body
  | commentsText as $comments
  | ([ (if $body == "" then empty else $body end),
       (if $comments == "" then empty else "--- Comments ---\n\n" + $comments end) ] | join("\n\n")) as $content
  | browseUrl as $url
  | ([ (if $repo != null then "Repository: " + $repo else empty end),
       (if $url  != null then "Issue: " + $url       else empty end) ] | join("\n")) as $hdr
  | { id: .key,
      title: (.fields.summary // .key),
      description: (if $hdr == "" then $content else $hdr + "\n\n" + $content end),
      status: canonStatus($rp; $tp),
      repository: $repo,
      agent: $agent,
      assignee: (.fields.assignee.displayName // "Unassigned"),
      updatedAt: (.fields.updated // ""),
      blockers: [],
      hasMoreBlockers: false,
      url: $url,
      sourceRef: { key: .key, nativeId: .id } }
  | if .url == null then del(.url) else . end;
JQ

require_token() {
  [[ -r "${TOKEN_FILE}" ]] || {
    echo "jira token file not found/readable: ${TOKEN_FILE}" >&2
    exit 1
  }
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  verify)
    require_token
    jira me >/dev/null
    ;;
  list)
    require_token
    # jira-cli's `issue list --raw` returns a reduced array (no id/self/
    # statusCategory), so we read just the keys and enrich each via `issue view`,
    # whose `--raw` is the full REST issue the transform needs. `jq -s` slurps
    # the stream of per-issue objects into one array.
    #
    # jira-cli exits non-zero (and prints to stderr) when a query matches
    # nothing. groundcrew's shell adapter treats any non-zero `listTasks` exit
    # as a fetch failure, so a no-match query (the steady state when no issue
    # carries the dispatch label) must NOT propagate that exit. Capture the list
    # separately: fold "no results" into an empty array, but still surface real
    # failures (auth, network) instead of masking them as "no tasks".
    list_err="$(mktemp)"
    trap 'rm -f "${list_err}"' EXIT
    if ! list_raw="$(jira issue list -q "${LIST_JQL}" --order-by updated --reverse --raw --paginate 0:20 2>"${list_err}")"; then
      # jira-cli has no machine-readable "empty result" signal, so we match its
      # stderr wording. These strings are validated against jira-cli 1.7.x and
      # may drift on upgrade (see README Prerequisites); the same caveat applies
      # to the not-found match in `get` below.
      if grep -qiE "no result|no issues" "${list_err}"; then
        list_raw="[]"
      else
        cat "${list_err}" >&2
        exit 1
      fi
    fi
    # Enrich each listed key with its full issue: 1 `list` + 1 `view` per key
    # (≤21 calls at the 20-issue cap), which can approach the 60s `listTasks`
    # timeout on a wide JQL — see README Notes. A failed `view` logs and skips
    # that one key rather than `|| true` silently dropping it from the array.
    printf '%s' "${list_raw:-[]}" \
      | jq -r 'if type == "array" then .[].key else empty end' \
      | while IFS= read -r key; do
          [[ -n "${key}" ]] || continue
          jira issue view "${key}" --raw 2>/dev/null \
            || { echo "jira.sh list: skipping ${key} (view failed)" >&2; continue; }
        done \
      | jq -s -c --arg rp "${REVIEW_PATTERN}" --arg tp "${TODO_PATTERN}" --arg da "${DEFAULT_AGENT}" \
            "${JQ_TRANSFORM} [ .[] | toShellIssue(\$rp; \$tp; \$da) ]"
    ;;
  get)
    require_token
    key="${1:?usage: jira.sh get <KEY>}"
    get_err="$(mktemp)"
    trap 'rm -f "${get_err}"' EXIT
    if ! out="$(jira issue view "${key}" --raw 2>"${get_err}")"; then
      # jira-cli exits non-zero for a genuinely missing key AND for transient
      # auth/network failures. Only the former is the not-found sentinel (exit 3);
      # surface the rest as a retryable error so groundcrew does not treat a live
      # task as vanished. Not-found wording validated vs jira-cli 1.7.x (see S3).
      if grep -qiE "not found|does not exist|404" "${get_err}"; then
        exit 3
      fi
      cat "${get_err}" >&2
      exit 1
    fi
    [[ -n "${out}" ]] || exit 3
    printf '%s' "${out}" \
      | jq -c --arg rp "${REVIEW_PATTERN}" --arg tp "${TODO_PATTERN}" --arg da "${DEFAULT_AGENT}" \
            "${JQ_TRANSFORM} toShellIssue(\$rp; \$tp; \$da)"
    ;;
  move)
    require_token
    key="${1:?usage: jira.sh move <KEY> <STATE>}"
    state="${2:?missing STATE}"
    jira issue move "${key}" "${state}" >/dev/null
    ;;
  *)
    echo "usage: jira.sh {verify|list|get <KEY>|move <KEY> <STATE>}" >&2
    exit 2
    ;;
esac
