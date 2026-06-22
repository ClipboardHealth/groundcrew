# Task sources

First-class, connectable [task sources](../docs/task-sources.md) for groundcrew.
Each subdirectory is a self-contained source that can be installed into a user's
`crew.config.json`.

## Anatomy of a source

| File          | Purpose                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `source.json` | Install manifest (see below). The canonical description of the wiring.       |
| `README.md`   | Human setup guide. Its config block renders the same wiring as the manifest. |
| script(s)     | The executable(s) the manifest lists in `files` (e.g. `jira.sh`).            |

## Manifest (`source.json`)

A machine-readable description that the
[crew-config](https://github.com/clipboard-health/groundcrew-config) TUI reads to
install a source. groundcrew itself does **not** load it at runtime — it is a
contract between this repo (which produces sources) and crew-config (which writes
them into `crew.config.json`).

| Field           | Consumed by  | Purpose                                                  |
| --------------- | ------------ | -------------------------------------------------------- |
| `name`, `kind`  | crew.config  | written into the `sources[]` entry                       |
| `commands`      | crew.config  | command templates, written verbatim (`${id}` is runtime) |
| `env`           | crew.config  | environment defaults, written verbatim                   |
| `installDir`    | install step | where `files` are copied                                 |
| `files`         | install step | scripts copied to `installDir`, made executable          |
| `prerequisites` | install step | binaries to check on PATH, with install/setup hints      |
| `secrets`       | install step | secrets to prompt for and write to a file                |
| `description`   | TUI / docs   | human-readable summary                                   |

The command keys (`verify`, `listTasks`, `getTask`, `markInProgress`,
`markInReview`, `markDone`) match groundcrew's shell adapter contract;
`listTasks` is required.

## Available sources

- [`jira/`](./jira/README.md) — JIRA issues via the
  [`jira` CLI](https://github.com/ankitpokhrel/jira-cli).
- [`pr-followups/`](./pr-followups/README.md) - followup refactoring PRs for each merged PR (read-only, local state).
