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
#   JIRA_GROUNDCREW_JQL  JQL for `list`  (default: statusCategory != Done ORDER BY updated DESC)
#   JIRA_REVIEW_PATTERN  case-insensitive regex; matching status names -> in-review (default: review)
#   JIRA_DEFAULT_AGENT   agent when an issue has no agent:<x> label (default: empty -> null)
#   JIRA_TOKEN_FILE      token path (default: ~/.config/groundcrew/jira.token)
set -euo pipefail

TOKEN_FILE="${JIRA_TOKEN_FILE:-${HOME}/.config/groundcrew/jira.token}"
LIST_JQL="${JIRA_GROUNDCREW_JQL:-statusCategory != Done ORDER BY updated DESC}"
REVIEW_PATTERN="${JIRA_REVIEW_PATTERN:-review}"
DEFAULT_AGENT="${JIRA_DEFAULT_AGENT:-}"

if [[ -r "${TOKEN_FILE}" ]]; then
  JIRA_API_TOKEN="$(cat "${TOKEN_FILE}")"
  export JIRA_API_TOKEN
fi

# Reshape one JIRA REST issue -> one groundcrew ShellIssue. Shared by list & get
# so the two code paths can never drift. Labels carry dispatch metadata:
#   repo:Owner__name -> repository "Owner/name"   (__ decodes to /)
#   agent:<name>     -> agent "<name>"
read -r -d '' JQ_TRANSFORM <<'JQ' || true
def adfText: [.. | .text? // empty] | join(" ");
def labelValue($p):
  ((.fields.labels // []) | map(select(startswith($p))) | .[0] // null)
  | if . == null then null else ltrimstr($p) end;
def browseUrl:
  ((.self // "") | capture("^(?<b>https?://[^/]+)") | .b) as $base
  | if ($base // "") == "" then null else $base + "/browse/" + .key end;
def canonStatus($rp):
  (.fields.status.statusCategory.key // "") as $c
  | (.fields.status.name // "") as $n
  | if   $c == "done"          then "done"
    elif $c == "new"           then "todo"
    elif $c == "indeterminate" then (if ($n | test($rp; "i")) then "in-review" else "in-progress" end)
    else "other" end;
def toShellIssue($rp; $da):
  (labelValue("repo:")  | if . == null then null else gsub("__"; "/") end) as $repo
  | (labelValue("agent:") // (if $da == "" then null else $da end)) as $agent
  | (.fields.description) as $d
  | (if   ($d | type) == "string" then $d
     elif ($d | type) == "object" then ($d | adfText)
     else "" end) as $body
  | browseUrl as $url
  | ([ (if $repo != null then "Repository: " + $repo else empty end),
       (if $url  != null then "Issue: " + $url       else empty end) ] | join("\n")) as $hdr
  | { id: .key,
      title: (.fields.summary // .key),
      description: (if $hdr == "" then $body else $hdr + "\n\n" + $body end),
      status: canonStatus($rp),
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
    jira issue list -q "${LIST_JQL}" --raw --paginate 0:100 \
      | jq -c --arg rp "${REVIEW_PATTERN}" --arg da "${DEFAULT_AGENT}" \
            "${JQ_TRANSFORM} [ (.issues // [])[] | toShellIssue(\$rp; \$da) ]"
    ;;
  get)
    require_token
    key="${1:?usage: jira.sh get <KEY>}"
    out="$(jira issue view "${key}" --raw 2>/dev/null)" || exit 3
    [[ -n "${out}" ]] || exit 3
    printf '%s' "${out}" \
      | jq -c --arg rp "${REVIEW_PATTERN}" --arg da "${DEFAULT_AGENT}" \
            "${JQ_TRANSFORM} toShellIssue(\$rp; \$da)"
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
