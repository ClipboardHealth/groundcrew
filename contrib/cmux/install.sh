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
  backup="${target}.$(date +%Y%m%d%H%M%S).bak"
  cp "${target}" "${backup}"
  echo "backed up existing sidebar to ${backup}"
fi

sed "s|__GROUNDCREW_DIR__|${groundcrew_dir}|g" "${script_dir}/groundcrew.swift" >"${target}"

cmux sidebar validate groundcrew

echo "installed ${target}"
echo "activate it with: cmux sidebar select groundcrew"
