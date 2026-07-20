# todo-txt source bundle

The zero-credential default source. The task store is a plain
[todo.txt](https://github.com/todotxt/todo.txt)-format file; every line is a
task. No secrets, no network — it runs entirely against the local filesystem.

## Configuration

| Env         | Purpose                         | Default      |
| ----------- | ------------------------------- | ------------ |
| `TODO_FILE` | Path to the todo.txt task store | `~/todo.txt` |

`TODO_FILE` is declared in the manifest `environment` block; override it per
source in `crew.config.jsonc`:

```jsonc
{ "sources": [{ "kind": "todo-txt", "environment": { "TODO_FILE": "~/work/todo.txt" } }] }
```

A leading `~/` is expanded to your home directory. A missing file lists as
empty (it is created on the first successful writeback).

## Line grammar

Each non-blank, non-`#` line is one task, following the todo.txt format with a
few groundcrew-specific `key:value` tags:

```text
[x] [(A)] [YYYY-MM-DD] <title words> [+project] [@context] [key:value ...]
```

| Element        | Meaning                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| leading `x`    | line is completed → `terminal: true`                                                                                                                                                         |
| `(A)`…`(Z)`    | priority; **`(A)` is highest.** Mapped so a higher protocol number sorts first: `(A)`→26, `(B)`→25, … `(Z)`→1.                                                                               |
| `YYYY-MM-DD`   | optional creation date (after the priority); ignored for routing                                                                                                                             |
| `id:<slug>`    | explicit stable id. **Absent → a stable SHA-256 hash of the trimmed line** (12 hex chars). If you plan to edit a line after dispatch, give it an explicit `id:` so the id survives the edit. |
| `repos:a,b`    | repo designation (comma-separated, repeatable) → task `repos`                                                                                                                                |
| `agent:<name>` | agent routing → task `agent`                                                                                                                                                                 |
| `blocked:<v>`  | blocked unless `v` ∈ {`false`,`0`,`no`} → task `blocked`                                                                                                                                     |

Words that are not tags/projects/contexts form the task `title`; the full
trimmed line is also returned as the task `description`.

Example:

```text
(A) Ship the login fix id:LOGIN-1 repos:web,api agent:claude
(C) Write migration notes id:DOCS-2
x 2026-07-18 (B) Old done task id:OLD-9
Investigate flaky test blocked:true id:FLAKE-3
```

## Commands

- **`list`** — every parsed line as a protocol task (completed lines included
  with `terminal: true` so the cleaner can reap them).
- **`get`** `{ "id": "LOGIN-1" }` — one task by id.
- **`update`** `{ "id", "event" }`:
  - `claimed` → `{ "result": "ok" }` (no mutation; the file is single-writer, no contention arbitration).
  - `completed` with `outcome: "delivered"` → the line is marked done in place:
    `x <today> …`, moving any `(A)` priority into a `pri:A` tag per todo.txt
    convention.
  - `completed` with `outcome: "failed"` / `"stopped"` → the line is **left
    open** and annotated with `gc-outcome:<outcome> gc-updated:<today>` (plus a
    slugged `gc-note:` when a message is supplied), so the work stays in the
    queue for another attempt.
  - `progress` → `{ "result": "ok" }`, no mutation.

All commands read one JSON object on stdin and write one protocol result object
on stdout (`{ "ok": true, "data": … }` / `{ "ok": false, "error": { "message" } }`).
