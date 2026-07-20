/**
 * Status rendering (design §10.3/§10.4): the two layers are labelled "observed"
 * (git facts groundcrew verified) and "reported" (agent claims groundcrew never
 * checks). Human output for people; `--json` for scripts. The tokens here are
 * the affordances the e2e suite matches loosely — observed/reported, read-only,
 * sandbox off, stray/dead, queue unavailable, the skip reasons, the protocol
 * mismatch and its supported set, and the user-override marker.
 */
import type {
  QueuedView,
  RunView,
  SourceView,
  StatusModel,
  StraySession,
} from "./statusModel.js";

export function renderStatusHuman(model: StatusModel): string {
  const lines: string[] = [];

  if (model.scope === "task") {
    renderTaskDetail(model, lines);
  } else {
    renderOverview(model, lines);
  }

  return lines.join("\n");
}

function renderTaskDetail(model: StatusModel, lines: string[]): void {
  if (model.missingTaskId !== undefined) {
    lines.push(`No run record for ${model.missingTaskId}.`);
    renderQueueFor(model, model.missingTaskId, lines);
    renderSources(model, lines);
    return;
  }

  const run = model.runs[0];
  if (run === undefined) {
    lines.push("No matching task.");
    return;
  }

  const record = run.record;
  lines.push(
    `Task ${record.taskId}  [${record.state}]${outcomeSuffix(run)}`,
    "",
    "observed  (git facts groundcrew verified itself):",
  );
  renderObserved(run, lines);
  lines.push("", "reported  (agent claims via crew artifact add / crew done — never checked):");
  renderReported(run, lines);
  lines.push("");

  renderSessionLine(model, run, lines);
  lines.push(
    `logs: ${model.logFile}` +
      `  |  jq 'select(.runId=="${record.runId}")' ${model.logFile}`,
  );
}

function renderObserved(run: RunView, lines: string[]): void {
  const observation = run.observation;
  if (observation === undefined || observation.repos.length === 0) {
    lines.push("  (no worktrees on disk)");
    return;
  }

  for (const repo of observation.repos) {
    lines.push(`  ${repo.repo} on ${repo.branch}`);
    if (repo.commitsAhead.length === 0) {
      lines.push("    commits: none yet");
    } else {
      for (const subject of repo.commitsAhead) {
        lines.push(`    commit: ${subject}`);
      }
    }

    lines.push(
      repo.dirtyFiles.length === 0
        ? "    clean"
        : `    dirty: ${repo.dirtyFiles.join(", ")}`,
    );
  }
}

function renderReported(run: RunView, lines: string[]): void {
  const record = run.record;
  lines.push(`  state: ${record.state}`);
  if (record.outcome !== undefined) {
    lines.push(`  outcome: ${record.outcome}`);
  }

  if (record.artifacts.length === 0) {
    lines.push("  artifacts: none reported");
  } else {
    for (const artifact of record.artifacts) {
      const title = artifact.title === undefined ? "" : ` — ${artifact.title}`;
      const repo = artifact.repo === undefined ? "" : ` (${artifact.repo})`;
      lines.push(`  artifact reported: ${artifact.kind} ${artifact.locator}${title}${repo}`);
    }
  }

  for (const event of record.events) {
    const detail = event.detail === undefined ? "" : ` ${event.detail}`;
    lines.push(`  event: ${event.event}${detail} @ ${event.ts}`);
  }
}

function renderSessionLine(model: StatusModel, run: RunView, lines: string[]): void {
  if (!model.probeAvailable) {
    lines.push("session: presenter probe unavailable (liveness unknown)");
    return;
  }

  if (run.record.state === "running" && run.sessionAlive === false) {
    lines.push("session: dead (expected a live session; none found — orphaned run)");
    return;
  }

  lines.push(`session: ${run.sessionAlive === true ? "live" : "none"}`);
}

function renderOverview(model: StatusModel, lines: string[]): void {
  lines.push("Runs:");
  if (model.runs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const run of model.runs) {
      lines.push(`  ${overviewRunLine(model, run)}`);
    }
  }

  lines.push("", "Queue:");
  if (model.queue.length === 0) {
    lines.push("  (empty)");
  } else {
    for (const queued of model.queue) {
      lines.push(`  ${queueLine(queued)}`);
    }
  }

  lines.push("");
  renderSources(model, lines);

  if (model.strays.length > 0 || model.deadRuns.length > 0) {
    lines.push("", "Reconcile:");
    for (const stray of model.strays) {
      lines.push(`  ${strayLine(stray)}`);
    }

    for (const run of model.deadRuns) {
      lines.push(`  dead: ${run.record.taskId} (run running but no live session — orphaned)`);
    }
  }
}

function overviewRunLine(model: StatusModel, run: RunView): string {
  const record = run.record;
  const observed = observedSummary(run);
  const reported =
    record.outcome === undefined
      ? `${String(record.artifacts.length)} artifact(s) reported`
      : `outcome ${record.outcome}`;
  const session = sessionToken(model, run);
  return `${record.taskId}  [${record.state}]  session:${session}  observed:${observed}  reported:${reported}`;
}

function observedSummary(run: RunView): string {
  const observation = run.observation;
  if (observation === undefined || observation.repos.length === 0) {
    return "no-worktrees";
  }

  const commits = observation.repos.reduce((sum, repo) => sum + repo.commitsAhead.length, 0);
  const dirty = observation.repos.some((repo) => repo.dirtyFiles.length > 0);
  return `${observation.branch}(${String(commits)} commit(s), ${dirty ? "dirty" : "clean"})`;
}

function sessionToken(model: StatusModel, run: RunView): string {
  if (!model.probeAvailable) {
    return "unknown";
  }

  if (run.record.state === "running" && run.sessionAlive === false) {
    return "dead";
  }

  return run.sessionAlive === true ? "live" : "none";
}

function queueLine(queued: QueuedView): string {
  const parts = [queued.taskId];
  if (queued.title !== undefined) {
    parts.push(`"${queued.title}"`);
  }

  if (queued.blocked) {
    parts.push("[blocked]");
  }

  if (queued.verdict !== undefined) {
    const detail = queued.verdict.detail === undefined ? "" : ` ${queued.verdict.detail}`;
    parts.push(`skip: ${queued.verdict.skipReason}${detail}`);
  }

  return parts.join("  ");
}

function renderQueueFor(model: StatusModel, taskId: string, lines: string[]): void {
  const queued = model.queue.find((entry) => entry.taskId === taskId);
  if (queued !== undefined) {
    lines.push(`Queue: ${queueLine(queued)}`);
  }
}

function renderSources(model: StatusModel, lines: string[]): void {
  lines.push("Sources:");
  if (model.sources.length === 0) {
    lines.push("  (none configured)");
    return;
  }

  for (const source of model.sources) {
    lines.push(`  ${sourceLine(source)}`);
  }
}

function sourceLine(source: SourceView): string {
  const parts = [source.name];
  if (source.origin !== undefined) {
    parts.push(source.origin);
  }

  if (source.status === "ok") {
    parts.push(`protocol ${String(source.protocolVersion)}`);
    if (source.readOnly) {
      parts.push("read-only");
    }
  } else if (source.status === "unsupported") {
    parts.push(
      `unsupported: protocol ${String(source.protocolVersion)}` +
        ` (supported: ${(source.supportedVersions ?? []).join(", ")})`,
    );
  } else if (source.status === "invalid") {
    parts.push("invalid manifest");
  } else {
    parts.push("not discovered");
  }

  if (source.sandboxOff) {
    parts.push("sandbox off");
  }

  if (source.shadows !== undefined) {
    parts.push(`overrides ${source.shadows} bundle`);
  }

  if (source.queueUnavailable !== undefined) {
    parts.push(`queue unavailable: ${source.queueUnavailable}`);
  }

  return parts.join("  ");
}

function strayLine(stray: StraySession): string {
  return `stray: ${stray.name} (${stray.alive ? "alive" : "dead"}; no run record)`;
}

function outcomeSuffix(run: RunView): string {
  return run.record.outcome === undefined ? "" : `  outcome: ${run.record.outcome}`;
}

/** Machine-readable status (contracts §7 `--json`). */
export function renderStatusJson(model: StatusModel): string {
  return JSON.stringify(
    {
      scope: model.scope,
      probeAvailable: model.probeAvailable,
      runs: model.runs.map((run) => ({
        taskId: run.record.taskId,
        runId: run.record.runId,
        state: run.record.state,
        outcome: run.record.outcome ?? null,
        sessionAlive: run.sessionAlive ?? null,
        reported: {
          artifacts: run.record.artifacts,
          events: run.record.events,
        },
        observed:
          run.observation === undefined
            ? null
            : {
                branch: run.observation.branch,
                repos: run.observation.repos.map((repo) => ({
                  repo: repo.repo,
                  branch: repo.branch,
                  commitsAhead: repo.commitsAhead,
                  dirtyFiles: repo.dirtyFiles,
                })),
              },
      })),
      queue: model.queue,
      sources: model.sources,
      strays: model.strays,
      deadRuns: model.deadRuns.map((run) => run.record.taskId),
      logFile: model.logFile,
    },
    undefined,
    2,
  );
}
