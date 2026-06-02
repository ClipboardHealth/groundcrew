#!/usr/bin/env bash
set -euo pipefail

# Semantic ANSI colors. Actual hues are defined by the VHS theme in demo.tape,
# so content and chrome stay in sync: green = orchestrator, yellow = codex,
# blue = claude, bright-black = dim chrome.
c_reset=$'\033[0m'
c_dim=$'\033[90m'
c_green=$'\033[32m'
c_amber=$'\033[33m'
c_blue=$'\033[34m'

export PS1="\[${c_green}\]groundcrew\[${c_dim}\] on \[${c_reset}\]main \[${c_green}\]\$\[${c_reset}\] "

tmux rename-window 'crew run --watch'
tmux set-option -g status off
tmux set-option -g pane-border-status top
tmux set-option -g pane-border-format ' #{?#{m:codex*,#{pane_title}},#[fg=#fbbf24],#{?#{m:claude*,#{pane_title}},#[fg=#60a5fa],#[fg=#77d94e]}}#[bold]#{pane_title}#[default] '
# Use one divider color for active and inactive panes. tmux highlights only the
# active-adjacent segment of a shared divider, so a distinct active color makes a
# single divider render two-tone (and the dim half reads as "missing"). A uniform
# color keeps every divider a clean, continuous line. Accent lives in pane titles.
tmux set-option -g pane-border-style 'fg=#52525b'
tmux set-option -g pane-active-border-style 'fg=#52525b'
tmux set-option -g remain-on-exit on

printf '\033]2;groundcrew\033\\'

# This agent script prints 12 lines into a split pane. The pane heights are set
# by `Set Height` in demo.tape (see the note there) so all 12 fit without
# scrolling — a scrolling pane makes its top border drift. If you add or remove
# output lines here, keep that height in sync.
demo_agent_script="$(mktemp "${TMPDIR:-/tmp}/groundcrew-vhs-agent.XXXXXX")"
trap 'rm -f "${demo_agent_script}"' EXIT
cat >"${demo_agent_script}" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

ticket="${1}"
model="${2}"
title="${3}"
worktree="${4:-groundcrew-${ticket}}"
branch="groundcrew/${ticket}"

reset=$'\033[0m'
bold=$'\033[1m'
dim=$'\033[90m'
green=$'\033[32m'
case "${model}" in
  codex) accent=$'\033[33m' ;;
  claude) accent=$'\033[34m' ;;
  *) accent=$'\033[32m' ;;
esac

printf '\033]2;%s %s\033\\' "${model}" "${ticket}"
printf '%s%s%s    clipboard/groundcrew\n' "${dim}" 'repo' "${reset}"
printf '%s%s%s  %s\n\n' "${dim}" 'branch' "${reset}" "${branch}"
sleep 0.4
printf '%s$%s %s%s%s %s< prompts/%s.txt%s\n\n' "${dim}" "${reset}" "${accent}" "${model}" "${reset}" "${dim}" "${ticket}" "${reset}"
sleep 0.5
printf '%sTicket%s    %s\n' "${dim}" "${reset}" "${title}"
sleep 0.4
printf '%sWorktree%s  %s~/dev/c/%s%s\n\n' "${dim}" "${reset}" "${dim}" "${worktree}" "${reset}"
sleep 0.5
printf '%sReading repo context...%s\n' "${dim}" "${reset}"
sleep 0.5
printf '%sEditing in isolated branch...%s\n' "${dim}" "${reset}"
sleep 0.5
printf '%sRunning verification...%s\n' "${dim}" "${reset}"
sleep 0.5
# No trailing newline: keeps the final line flush against the pane bottom so the
# pane never has to scroll a phantom empty line (which VHS renders as the top
# border drifting down).
printf '%s%s✓ Ready for review.%s' "${green}" "${bold}" "${reset}"

while :; do
  sleep 60
done
SH
chmod +x "${demo_agent_script}"

demo_ts_second=18

demo_log() {
  printf '%s[15:23:%02d]%s %s\n' "${c_dim}" "${demo_ts_second}" "${c_reset}" "${1}"
  demo_ts_second=$((demo_ts_second + 1))
}

crew() {
  if [[ "${1:-}" != "run" || "${2:-}" != "--watch" ]]; then
    printf '%s\n' 'demo supports: crew run --watch'
    return 2
  fi

  local pane_one

  demo_log "${c_dim}Linear viewer ·${c_reset} Rocky Warren"
  sleep 0.5
  demo_log "${c_dim}Slots${c_reset} 0/3 ${c_dim}· dispatching${c_reset} ${c_amber}ENG-184${c_reset}${c_dim},${c_reset} ${c_blue}ENG-217${c_reset}"
  sleep 0.6

  demo_log "${c_dim}Worktree${c_reset} web-ENG-184 ${c_dim}→${c_reset} groundcrew/ENG-184"
  sleep 0.5
  pane_one="$(
    tmux split-window -d -h -p 42 -P -F '#{pane_id}' -- \
      "${demo_agent_script} ENG-184 codex 'Add Jira ticket source docs' web-ENG-184"
  )"
  sleep 0.7
  demo_log "${c_green}✓${c_reset} ${c_amber}ENG-184${c_reset} launched ${c_dim}·${c_reset} ${c_amber}codex${c_reset}"
  sleep 0.7

  demo_log "${c_dim}Worktree${c_reset} api-ENG-217 ${c_dim}→${c_reset} groundcrew/ENG-217"
  sleep 0.5
  tmux split-window -d -v -p 50 -t "${pane_one}" -P -F '#{pane_id}' -- \
    "${demo_agent_script} ENG-217 claude 'Fix flaky status output' api-ENG-217" >/dev/null
  sleep 0.7
  demo_log "${c_green}✓${c_reset} ${c_blue}ENG-217${c_reset} launched ${c_dim}·${c_reset} ${c_blue}claude${c_reset}"
  sleep 0.7

  demo_log "${c_dim}Queue clear · next poll in 60s${c_reset}"
  tmux refresh-client
  # Hold the fully-settled layout on screen. Must outlast the tape's trailing
  # Sleep so the orchestrator pane never drops back to a shell prompt on camera.
  sleep 20
}
