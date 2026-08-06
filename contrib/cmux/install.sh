#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
groundcrew_dir="${GROUNDCREW_DIR:-$(cd "${script_dir}/../.." && pwd)}"
sidebar_dir="${HOME}/.config/cmux/sidebars"
target="${sidebar_dir}/groundcrew.swift"

if ! command -v cmux >/dev/null 2>&1; then
  echo "cmux is not on PATH; install cmux before running this script" >&2
  exit 1
fi

if [[ ! -f "${groundcrew_dir}/package.json" ]]; then
  echo "GROUNDCREW_DIR does not look like the groundcrew checkout: ${groundcrew_dir}" >&2
  echo "re-run with GROUNDCREW_DIR=/path/to/groundcrew $0" >&2
  exit 1
fi

mkdir -p "${sidebar_dir}"

if [[ -e "${target}" ]]; then
  backup="$(mktemp "${target}.$(date +%Y%m%d%H%M%S).bak.XXXXXX")"
  cp "${target}" "${backup}"
  echo "backed up existing sidebar to ${backup}"
fi

# A sed replacement string interprets &, \, and the delimiter itself, so any
# of those in groundcrew_dir (e.g. a checkout under a path with & or |) would
# corrupt the substitution. Bash's ${var//search/replace} treats both sides
# as literal text, so no escaping is needed here.
source_content="$(cat "${script_dir}/groundcrew.swift")"
printf '%s\n' "${source_content//__GROUNDCREW_DIR__/${groundcrew_dir}}" >"${target}"

if ! cmux sidebar validate groundcrew; then
  if [[ -n "${backup:-}" ]]; then
    cp "${backup}" "${target}"
    echo "validation failed; restored previous sidebar from ${backup}" >&2
  else
    rm -f "${target}"
    echo "validation failed; removed unvalidated sidebar" >&2
  fi
  exit 1
fi

echo "installed ${target}"
echo "activate it with: cmux sidebar select groundcrew"
