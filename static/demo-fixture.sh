#!/usr/bin/env bash
set -euo pipefail

export PS1='groundcrew on main $ '

tmux rename-window 'crew run --watch'
tmux set-option -g status off
tmux set-option -g pane-border-status top
tmux set-option -g pane-border-format ' #{pane_title} '
tmux set-option -g pane-border-style 'fg=white'
tmux set-option -g pane-active-border-style 'fg=green'
tmux set-option -g remain-on-exit on

printf '\033]2;groundcrew\033\\'

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

printf '\033]2;%s %s\033\\' "${model}" "${ticket}"
printf '%s\n' "${model} ${ticket}"
printf '%s\n' 'repo: clipboard/groundcrew'
printf '%s\n\n' "branch: ${branch}"
sleep 0.4
printf '$ %s < /tmp/groundcrew/prompts/%s.txt\n\n' "${model}" "${ticket}"
sleep 0.5
printf 'Ticket: %s\n' "${title}"
sleep 0.5
printf 'Worktree: ~/dev/c/%s\n' "${worktree}"
sleep 0.5
printf 'Reading repo context...\n'
sleep 0.5
printf 'Editing in isolated branch...\n'
sleep 0.5
printf 'Running verification...\n'
sleep 0.5
printf 'Ready for review.\n'

while :; do
  sleep 60
done
SH
chmod +x "${demo_agent_script}"

demo_ts_second=18

demo_log() {
  printf '[3:23:%02d PM] %s\n' "${demo_ts_second}" "${1}"
  demo_ts_second=$((demo_ts_second + 1))
}

crew() {
  if [[ "${1:-}" != "run" || "${2:-}" != "--watch" ]]; then
    printf '%s\n' 'demo supports: crew run --watch'
    return 2
  fi

  local pane_one

  demo_log 'Resolved Linear viewer: Rocky Warren'
  sleep 0.5
  demo_log 'Slots 0/3 used, starting 2 ticket(s): ENG-184(codex), ENG-217(claude)'
  sleep 0.5

  demo_log 'Creating worktree web-ENG-184 (branch groundcrew/ENG-184 from origin/main)...'
  sleep 0.5
  pane_one="$(
    tmux split-window -d -h -p 45 -P -F '#{pane_id}' -- \
      "${demo_agent_script} ENG-184 codex 'Add Jira ticket source docs' web-ENG-184"
  )"
  sleep 0.6
  demo_log 'OK "ENG-184" launched (codex)  worktree web-ENG-184'
  sleep 0.6

  demo_log 'Creating worktree api-ENG-217 (branch groundcrew/ENG-217 from origin/main)...'
  sleep 0.5
  tmux split-window -d -v -p 50 -t "${pane_one}" -P -F '#{pane_id}' -- \
    "${demo_agent_script} ENG-217 claude 'Fix flaky status output' api-ENG-217" >/dev/null
  sleep 0.6
  demo_log 'OK "ENG-217" launched (claude)  worktree api-ENG-217'
  sleep 0.6

  demo_log 'No Todo tickets to pick up; next poll in 60s'
  sleep 8
}
