# 0008. 14-command CLI surface with JSONC config

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5975](https://linear.app/clipboardhealth/issue/DEVOP-5975)
- Design doc: §7

## Context

v1 had ~20 commands, a TypeScript config format, and env-based secrets.

## Decision

- **14 command leaves**: `start` (merges v1 `run`+`start`), `status`, `pause`/`resume`,
  `cleanup`; in-session `repo add` / `artifact add` / `done`; `source list` / `source doctor`;
  `init`, `doctor`, `upgrade`, `completions`. `doctor` is the health verb everywhere.
- **`crew.config.jsonc`** with a published JSON Schema generated from zod. TS config dies.
  Omitted = detected; specified = exactly yours, never merged. No schema field accepts a secret.
- **Task identity**: `--task` → `$GROUNDCREW_WORKSPACE` → walk up to `.groundcrew/task.json`.
  Exit **2** = repo not cloned under baseDirectory; **3** = no task context.
- **Setup**: `install.sh` → `crew init`.

## Consequences

- Killed: `open`, `task create/list/get/validate`, `source install`, `interrupt`, `sandbox`,
  `setup`, the `crew-clearance-ensure` bin. No `crew migrate`, no `progress` command in v2.0.
