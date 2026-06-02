#!/usr/bin/env bash
# cspell:ignore ttyd
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_dir}"

for required_command in vhs ttyd tmux ffmpeg; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "${required_command}" >&2
    exit 127
  fi
done

tmux -f /dev/null -L groundcrew-demo kill-session -t groundcrew 2>/dev/null || true

log_file="$(mktemp)"
trap 'rm -f "${log_file}"' EXIT

for attempt in 1 2 3; do
  rm -f "${log_file}"

  if VHS_NO_SANDBOX="${VHS_NO_SANDBOX:-1}" vhs static/demo.tape 2>&1 | tee "${log_file}"; then
    exit 0
  fi

  status="${PIPESTATUS[0]}"
  tmux -f /dev/null -L groundcrew-demo kill-session -t groundcrew 2>/dev/null || true

  if ! grep -Eq 'could not open ttyd|ERR_CONNECTION_REFUSED' "${log_file}"; then
    exit "${status}"
  fi

  if [[ "${attempt}" -eq 3 ]]; then
    exit "${status}"
  fi

  sleep "${attempt}"
done
