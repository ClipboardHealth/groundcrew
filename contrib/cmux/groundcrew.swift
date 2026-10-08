// PR links open in: "linear-app" (desktop app), "linear" (browser), or "github".
func prLinkTarget() -> String {
  return "github"
}

func prLink(_ pr) -> String {
  let path = pr.url.replacingOccurrences(of: "https://github.com/", with: "")
  if prLinkTarget() == "linear-app" {
    return "linear://linear.app/review/" + path
  }
  if prLinkTarget() == "linear" {
    return pr.url.replacingOccurrences(of: "github.com", with: "linear.review")
  }
  return pr.url
}

func hasPR(_ w) -> Bool {
  if let pr = w.pr {
    return true
  }
  return false
}

// Every key this poller writes (crew_stage/crew_ticket/crew_labels/heartbeat)
// describes the PR pipeline, not workspace lifecycle, so none of them may
// leak into the native status pill — including the edge case where one of
// them is the workspace's only status entry (then w.status IS that entry,
// since w.status is just the highest-priority one).
func isCrewManagedStatusKey(_ key) -> Bool {
  if key == "crew_stage" { return true }
  if key == "crew_ticket" { return true }
  if key == "crew_labels" { return true }
  if key == "crew_poller_heartbeat" { return true }
  return false
}

func hasStatus(_ w) -> Bool {
  if let s = w.status {
    if isCrewManagedStatusKey(s.key) {
      return false
    }
    return true
  }
  return false
}

func hasAgents(_ w) -> Bool {
  if let ags = w.agents {
    if ags.count > 0 {
      return true
    }
  }
  return false
}

// groundcrew's pr-stage-sync resolves the ticket once per tick (from the
// workspace's own title/cwd) and writes it as a status; the sidebar just
// reads it back instead of re-deriving it every render. Unlike crew_stage,
// crew_ticket is written for every matched cmux task workspace regardless of
// cmux.prStages.enabled, so this works whether or not PR-stage sync is on.
func crewTicket(_ w) -> String {
  if let ss = w.statuses {
    if let entry = ss.first(where: { e in e.key == "crew_ticket" }) {
      return entry.value
    }
  }
  return ""
}

func isTask(_ w) -> Bool {
  if hasPR(w) {
    return true
  }
  if hasStatus(w) {
    return true
  }
  if hasAgents(w) {
    return true
  }
  if crewTicket(w) != "" {
    return true
  }
  return false
}

func isWorkbench(_ w) -> Bool {
  if w.pinned {
    return true
  }
  return false
}

func isTaskRow(_ w) -> Bool {
  if w.pinned {
    return false
  }
  return isTask(w)
}

// States that imply the agent is executing. Separate from the needs_input
// check because silence means something different here: an executing agent
// that goes quiet has stopped, whereas one waiting on a person is quiet by
// design.
func executingState(_ s) -> Bool {
  if s.contains("working") {
    return true
  }
  if s.contains("running") {
    return true
  }
  if s.contains("resumed") {
    return true
  }
  return false
}

func activityAt(_ a) -> Double {
  if let t = a.lastActivityAt {
    return t
  }
  return 0
}

// lastActivityAt is documented as always present; a missing value means the
// host broke that contract, so zero silence (not a demotion) is the safest
// degradation.
func silentSeconds(_ a, _ now) -> Double {
  let t = activityAt(a)
  if t <= 0 {
    return 0
  }
  return now - t
}

// An abandoned agent keeps its last reported state forever; the longest
// observed gap between hook events in a live session was 34 minutes, so 2h
// of silence means abandoned, not busy. needs_input is exempt: silence there
// is expected (waiting on a person) and demoting it would hide the prompt.
func effectiveStatus(_ a, _ now) -> String {
  if executingState(a.status) {
    if silentSeconds(a, now) > 7200 {
      return "stale"
    }
  }
  return a.status
}

func ageLabel(_ a, _ now) -> String {
  let secs = silentSeconds(a, now)
  if secs <= 0 {
    return "no activity time"
  }
  if secs < 90 {
    return String(Int(secs)) + "s ago"
  }
  if secs < 5400 {
    return String(Int(secs / 60)) + "m ago"
  }
  return String(Int(secs / 3600)) + "h ago"
}

func agentName(_ a) -> String {
  if a.name != "" {
    return a.name
  }
  return a.kind
}

func agentTooltip(_ a, _ now) -> String {
  let base = agentName(a) + " · " + stateText(effectiveStatus(a, now)) + " · " + ageLabel(a, now)
  if let t = a.title {
    return base + " — " + t
  }
  return base
}

func stateText(_ s) -> String {
  if s.contains("needs_input") {
    return "needs you"
  }
  if s.contains("stale") {
    return "no signal"
  }
  return s
}

// SF Symbols stand in for each runtime's brand mark: the interpreter's Image
// only resolves system symbols, so cmux's own AgentIcons assets are out of
// reach here. The tooltip carries the unambiguous name.
func agentIcon(_ k) -> String {
  if k.contains("claude") {
    return "sparkles"
  }
  if k.contains("codex") {
    return "circle.hexagongrid.fill"
  }
  if k.contains("gemini") {
    return "diamond.fill"
  }
  if k.contains("grok") {
    return "bolt.fill"
  }
  if k.contains("opencode") {
    return "chevron.left.forwardslash.chevron.right"
  }
  return "cpu"
}

func agentColor(_ k) -> String {
  if k.contains("claude") {
    return "#D97757"
  }
  if k.contains("codex") {
    return "#111827"
  }
  if k.contains("gemini") {
    return "#1A73E8"
  }
  if k.contains("grok") {
    return "#7C3AED"
  }
  if k.contains("opencode") {
    return "#0891B2"
  }
  return "#475569"
}

// Stale/ended agents fall back to neutral gray regardless of brand; every
// other state keeps the agent's brand color at a status-driven opacity.
func agentIconColor(_ a, _ now) -> String {
  let s = effectiveStatus(a, now)
  if s == "stale" {
    return "#94A3B8"
  }
  if s == "ended" {
    return "#94A3B8"
  }
  return agentColor(a.kind)
}

func agentIconOpacity(_ a, _ now, _ pulse) -> Double {
  let s = effectiveStatus(a, now)
  if executingState(s) {
    return pulse ? 1.0 : 0.4
  }
  if s == "idle" {
    return 0.45
  }
  if s == "stale" {
    return 0.3
  }
  if s == "ended" {
    return 0.3
  }
  return 0.45
}

// needs_input gets its own branch (brand icon ringed in amber) rather than a
// color/opacity table entry, since it is a background treatment, not a tint.
func agentIconView(_ a, _ now, _ pulse) -> some View {
  let tooltip = agentTooltip(a, now)
  if effectiveStatus(a, now) == "needs_input" {
    Image(systemName: agentIcon(a.kind))
      .font(.system(size: 12))
      .foregroundColor(agentColor(a.kind))
      .opacity(pulse ? 1.0 : 0.4)
      .padding(2)
      .background("#F59E0B33")
      .cornerRadius(8)
      .help(tooltip)
  } else {
    Image(systemName: agentIcon(a.kind))
      .font(.system(size: 12))
      .foregroundColor(agentIconColor(a, now))
      .opacity(agentIconOpacity(a, now, pulse))
      .help(tooltip)
  }
}

// One codex process can hold two registry records (cmux never retires the
// prior id on session-start). Collapse by pid; the freshest record wins,
// state rank only breaks ties between equally recent records.
func stateRank(_ s) -> Int {
  if s == "needs_input" {
    return 3
  }
  if s == "working" {
    return 2
  }
  if s == "idle" {
    return 1
  }
  return 0
}

func agentKey(_ a) -> String {
  if let p = a.pid {
    return "pid:" + String(p)
  }
  return "id:" + a.id
}

func newestActivityForKey(_ list, _ key) -> Double {
  return list.reduce(0) { acc, b in
    if agentKey(b) == key {
      if activityAt(b) > acc {
        return activityAt(b)
      }
    }
    return acc
  }
}

func bestRankForKey(_ list, _ key, _ now) -> Int {
  let newest = newestActivityForKey(list, key)
  return list.reduce(0) { acc, b in
    if agentKey(b) == key {
      if activityAt(b) == newest {
        if stateRank(effectiveStatus(b, now)) > acc {
          return stateRank(effectiveStatus(b, now))
        }
      }
    }
    return acc
  }
}

func bestAgentIdForKey(_ list, _ key, _ now) -> String {
  let newest = newestActivityForKey(list, key)
  let rank = bestRankForKey(list, key, now)
  if let f = list.first(where: { b in agentKey(b) == key && activityAt(b) == newest && stateRank(effectiveStatus(b, now)) == rank }) {
    return f.id
  }
  return ""
}

func distinctAgents(_ list, _ now) -> Array {
  return list.filter { a in bestAgentIdForKey(list, agentKey(a), now) == a.id }
}

// Deduped agent list for a row, computed once and reused both for the row's
// icon strip and for stage derivation — the pid dedup pass is only needed
// where an agent's *identity* matters, so it runs once per row instead of
// once per read site.
func liveAgentsOf(_ w, _ now) -> Array {
  if let ags = w.agents {
    return distinctAgents(ags, now)
  }
  return []
}

func panelNumber(_ w) -> String {
  if let r = w.ref {
    return lastSegment(r, ":")
  }
  return ""
}

func lastSegment(_ s, _ sep) -> String {
  let parts = s.split(separator: sep)
  if parts.isEmpty {
    return s
  }
  return parts[parts.count - 1]
}

// pr-stage-sync writes crew_stage/crew_ticket/crew_labels only on change,
// plus one crew_poller_heartbeat per pass (not per task) — on its own
// workspace when the watch loop runs inside one, else on a matched task
// workspace — so staleness is "no workspace has a heartbeat newer than 600s",
// never a per-row epoch. No workspace carrying a heartbeat AT ALL means
// cmux.prStages is disabled for every tracked task, not merely stale.
func heartbeatFresh(_ workspaces, _ now) -> Bool {
  return workspaces.contains { w in
    if let ss = w.statuses {
      if let entry = ss.first(where: { e in e.key == "crew_poller_heartbeat" }) {
        if let epoch = Double(entry.value) {
          return (now - epoch) <= 600
        }
      }
    }
    return false
  }
}

func anyHeartbeatSeen(_ workspaces) -> Bool {
  return workspaces.contains { w in
    if let ss = w.statuses {
      return ss.contains { e in e.key == "crew_poller_heartbeat" }
    }
    return false
  }
}

func crewStageSlug(_ w) -> String {
  if let ss = w.statuses {
    if let entry = ss.first(where: { e in e.key == "crew_stage" }) {
      return entry.value
    }
  }
  return ""
}

func crewLabelsRaw(_ w) -> String {
  if let ss = w.statuses {
    if let entry = ss.first(where: { e in e.key == "crew_labels" }) {
      return entry.value
    }
  }
  return ""
}

func hasCrewLabel(_ w, _ label) -> Bool {
  return crewLabelsRaw(w).contains(label)
}

// Raw existence checks, not identity: whether ANY agent record (including an
// abandoned duplicate) reports the state, which is what the stage decision
// needs. Cheaper than distinctAgents (no pid-dedup pass) and behaves the same
// for this question, since dedup only changes which record's identity wins,
// never whether the state exists somewhere in the list.
func agentNeedsInput(_ liveAgents, _ now) -> Bool {
  return liveAgents.contains { a in effectiveStatus(a, now) == "needs_input" }
}

func agentExecuting(_ liveAgents, _ now) -> Bool {
  return liveAgents.contains { a in executingState(effectiveStatus(a, now)) }
}

func nativeStatusNeedsInput(_ w) -> Bool {
  if hasStatus(w) {
    if let s = w.status {
      return s.value.contains("needs_input")
    }
  }
  return false
}

// First match wins: an agent waiting on a person outranks everything else,
// a still-running agent outranks a possibly-outdated PR stage, and a stale
// or absent PR stage on a workspace with no agent activity is unknown
// rather than silently hidden.
func rowStage(_ w, _ liveAgents, _ now, _ stagesFresh) -> String {
  if agentNeedsInput(liveAgents, now) {
    return "needs_you"
  }
  if nativeStatusNeedsInput(w) {
    return "needs_you"
  }
  if agentExecuting(liveAgents, now) {
    return "working"
  }
  if stagesFresh {
    let slug = crewStageSlug(w)
    if slug != "" {
      if slug == "ci_running" {
        return "working"
      }
      return slug
    }
  }
  if hasPR(w) {
    return "unknown"
  }
  return "waiting"
}

// True only when there is at least one PR-bearing task and the poller's
// heartbeat isn't fresh — the signal that the poller itself is the problem,
// not any individual workspace. Only meaningful once a heartbeat has been
// seen at all; the caption for the fully-off case is driven separately by
// stagesEverRun, so this never fires for a workspace set where no tracked
// task has ever had cmux.prStages enabled.
func stagesStale(_ tasks, _ stagesFresh, _ stagesEverRun) -> Bool {
  if !stagesEverRun {
    return false
  }
  if stagesFresh {
    return false
  }
  return tasks.contains { w in hasPR(w) }
}

// Row stripe/tint source: the same colors stageSection uses for its headers,
// indexed by stage slug so a row's color always matches the section it sits
// in — the per-row badge this used to feed is gone; this now feeds only the
// left stripe and background tint.
func stageBadgeColor(_ s) -> String {
  if s == "needs_you" {
    return "#F59E0B"
  }
  if s == "my_review" {
    return "#7C3AED"
  }
  if s == "ci_failing" {
    return "#DC2626"
  }
  if s == "changes_requested" {
    return "#DC2626"
  }
  if s == "needs_testing" {
    return "#2563EB"
  }
  if s == "peer_review" {
    return "#0D9488"
  }
  if s == "ready_to_merge" {
    return "#16A34A"
  }
  if s == "working" {
    return "#6A5ACD"
  }
  if s == "waiting" {
    return "#94A3B8"
  }
  if s == "merged" {
    return "#64748B"
  }
  if s == "closed" {
    return "#64748B"
  }
  return "#94A3B8"
}

// Client-side charset gate before pr.url is spliced into a shell string;
// the script re-validates with its own stricter regex, but nothing here
// should hand it a quote or shell metacharacter to begin with.
func isSafePrUrl(_ u) -> Bool {
  if !u.hasPrefix("https://github.com/") {
    return false
  }
  if u.contains("\"") {
    return false
  }
  if u.contains("'") {
    return false
  }
  if u.contains(" ") {
    return false
  }
  if u.contains(";") {
    return false
  }
  if u.contains("&") {
    return false
  }
  if u.contains("|") {
    return false
  }
  if u.contains("$") {
    return false
  }
  if u.contains("`") {
    return false
  }
  return true
}

func crewStagesCwd() -> String {
  return "__GROUNDCREW_DIR__"
}

// `label` is always one of the two literal names the sidebar itself passes in
// (never user input), so it needs no shell-escaping beyond the URL's own gate.
func labelToggleCommand(_ url, _ label, _ add) -> String {
  let verb = add ? "label-add" : "label-remove"
  let past = add ? "added" : "removed"
  return "echo '→ crew stage " + verb + " " + label + "'; crew stage " + verb + " " + url + " " + label + " && { cmux workspace close \"$CMUX_WORKSPACE_ID\"; echo; echo '✓ " + label + " " + past + " — close this tab when done'; }"
}

func refreshStagesCommand() -> String {
  return "echo '→ crew stage refresh'; crew stage refresh && { cmux workspace close \"$CMUX_WORKSPACE_ID\"; echo; echo '✓ stages refreshed — close this tab when done'; }"
}

func taskRow(_ r, _ now, _ pulse) -> some View {
  let w = r.w
  let color = r.color
  let ticket = r.ticket
  let task = ticket.lowercased()
  let liveAgents = r.agents
  let hasTicketPill = ticket != ""
  HStack(spacing: 0) {
    Rectangle().fill(color).frame(width: 3)
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        if panelNumber(w) != "" {
          Text("#" + panelNumber(w))
            .font(.system(size: 10)).monospacedDigit()
            .foregroundColor("#1E293B")
        }
        Text(w.title).font(.body).bold()
          .foregroundColor(w.selected ? "#EC4899" : .primary)
          .lineLimit(1)
        Spacer()
        HStack(spacing: 4) {
          ForEach(liveAgents) { a in agentIconView(a, now, pulse) }
        }
      }

      VStack(alignment: .leading, spacing: 2) {
        if hasTicketPill {
          Button(action: { openURL("linear://linear.app/clipboardhealth/issue/" + ticket) }) {
            HStack(spacing: 4) {
              Image(systemName: "ticket")
              Text(ticket).font(.caption)
            }
          }
        }
        if let prs = w.prs {
          ForEach(prs) { pr in
            Button(action: { openURL(prLink(pr)) }) {
              HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch")
                Text("PR #" + String(pr.number) + " · " + pr.status).font(.caption)
              }
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(8)
  }
  .frame(maxWidth: .infinity, alignment: .leading)
  .background(w.selected ? "#EC489926" : color + "14")
  .cornerRadius(8)
  .overlay { if w.selected { RoundedRectangle(cornerRadius: 8).stroke("#EC4899B3", lineWidth: 1.5) } }
  .opacity(w.selected ? 1.0 : 0.9)
  .contextMenu {
    Button(action: { cmux("workspace.close", workspace_id: w.id) }) {
      Label("Close workspace", systemImage: "xmark.circle")
    }
    if task != "" {
      Button(action: { cmux("workspace.create", initial_command: "echo '→ crew cleanup " + task + "'; crew cleanup " + task + " && { cmux workspace close " + w.id + "; echo; echo '✓ cleanup finished — close this tab when done'; }", cwd: "__GROUNDCREW_DIR__", focus: true) }) {
        Label("Cleanup workspace", systemImage: "trash")
      }
    }
    if let pr = w.pr {
      if isSafePrUrl(pr.url) {
        Divider()
        if hasCrewLabel(w, "self-reviewed") {
          Button(action: { cmux("workspace.create", initial_command: labelToggleCommand(pr.url, "self-reviewed", false), cwd: crewStagesCwd(), focus: false) }) {
            Label("Undo self-review", systemImage: "eye.slash")
          }
        } else {
          Button(action: { cmux("workspace.create", initial_command: labelToggleCommand(pr.url, "self-reviewed", true), cwd: crewStagesCwd(), focus: false) }) {
            Label("Self-review done", systemImage: "eye")
          }
        }
        if hasCrewLabel(w, "tested") {
          Button(action: { cmux("workspace.create", initial_command: labelToggleCommand(pr.url, "tested", false), cwd: crewStagesCwd(), focus: false) }) {
            Label("Undo testing", systemImage: "checkmark.circle")
          }
        } else {
          Button(action: { cmux("workspace.create", initial_command: labelToggleCommand(pr.url, "tested", true), cwd: crewStagesCwd(), focus: false) }) {
            Label("Testing done", systemImage: "checkmark.circle.fill")
          }
        }
        Button(action: { cmux("workspace.create", initial_command: refreshStagesCommand(), cwd: crewStagesCwd(), focus: false) }) {
          Label("Refresh stages", systemImage: "arrow.clockwise")
        }
      }
    }
  }
  .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
}

func stageSection(_ title, _ color, _ items, _ now, _ pulse) -> some View {
  if items.count > 0 {
    VStack(alignment: .leading, spacing: 4) {
      Text(title + " (" + String(items.count) + ")")
        .font(.subheadline).bold().foregroundColor(color)
      ForEach(items) { r in taskRow(r, now, pulse) }
    }
  }
}

VStack(alignment: .leading, spacing: 8) {
  let workbench = workspaces.filter { isWorkbench($0) }
  let tasks = workspaces.filter { isTaskRow($0) }
  let pulse = clock.second % 2 == 0
  let now = clock.epoch
  let stagesEverRun = anyHeartbeatSeen(workspaces)
  let stagesFresh = heartbeatFresh(workspaces, now)

  if workbench.count > 0 {
    Text("Workbench").font(.headline)
    ForEach(workbench) { w in
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Image(systemName: "pin.fill").font(.system(size: 10)).foregroundColor("#F59E0B")
          if panelNumber(w) != "" {
            Text("#" + panelNumber(w))
              .font(.system(size: 10)).monospacedDigit()
              .foregroundColor("#1E293B")
          }
          Text(w.title).font(.body).bold()
            .foregroundColor(w.selected ? "#EC4899" : .primary)
          Spacer()
        }
        ForEach(w.tabs) { t in
          Button(action: { cmux("surface.focus", surface_id: t.id) }) {
            HStack(spacing: 4) {
              Image(systemName: t.focused ? "chevron.right.circle.fill" : "terminal")
              Text(t.title).font(.caption)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(w.selected ? "#EC489926" : "#2563EB12")
      .cornerRadius(8)
      .overlay { if w.selected { RoundedRectangle(cornerRadius: 8).stroke("#EC4899B3", lineWidth: 1.5) } }
      .opacity(w.selected ? 1.0 : 0.9)
      .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
    }
    Divider()
  }

  Text("Groundcrew").font(.headline)
  if stagesStale(tasks, stagesFresh, stagesEverRun) {
    Text("PR stages stale — is crew run --watch running?")
      .font(.caption).foregroundColor("#B45309")
  }
  Text(String(tasks.count) + " tasks").font(.caption).foregroundColor(.secondary)
  Divider()

  // One pass over `tasks` computes each row's stage/color/ticket/live agents
  // exactly once; every section below filters this array instead of
  // re-deriving those values per section (previously 11 filters x rowStage,
  // plus separate distinctAgents/ticketOf recomputation inside taskRow
  // itself). `color` is the row's section (stage) color, not a lifecycle
  // color, so the left stripe and background tint always match the header
  // the row sits under.
  let rows = tasks.map { w in
    let liveAgents = liveAgentsOf(w, now)
    let stage = rowStage(w, liveAgents, now, stagesFresh)
    ["w": w, "color": stageBadgeColor(stage), "stage": stage, "ticket": crewTicket(w), "agents": liveAgents]
  }

  let needsYou = rows.filter { r in r.stage == "needs_you" }
  let myReview = rows.filter { r in r.stage == "my_review" }
  let ciFailing = rows.filter { r in r.stage == "ci_failing" }
  let changesRequested = rows.filter { r in r.stage == "changes_requested" }
  let needsTesting = rows.filter { r in r.stage == "needs_testing" }
  let peerReview = rows.filter { r in r.stage == "peer_review" }
  let readyToMerge = rows.filter { r in r.stage == "ready_to_merge" }
  let working = rows.filter { r in r.stage == "working" }
  let waiting = rows.filter { r in r.stage == "waiting" }
  let unknown = rows.filter { r in r.stage == "unknown" }
  let done = rows.filter { r in r.stage == "merged" || r.stage == "closed" }

  // When cmux.prStages has never run for any tracked task (no heartbeat seen
  // at all), "unknown" rows are simply PRs this feature has never evaluated,
  // not a stage that went stale — the section title says so instead of
  // implying something is broken.
  let unknownTitle = stagesEverRun ? "Stage unknown" : "Open PRs"

  stageSection("Needs you", "#F59E0B", needsYou, now, pulse)
  stageSection("Your review", "#7C3AED", myReview, now, pulse)
  stageSection("CI failing", "#DC2626", ciFailing, now, pulse)
  stageSection("Changes requested", "#DC2626", changesRequested, now, pulse)
  stageSection("Needs testing", "#2563EB", needsTesting, now, pulse)
  stageSection("Ready to merge", "#16A34A", readyToMerge, now, pulse)
  stageSection("Working", "#6A5ACD", working, now, pulse)
  stageSection("Waiting", "#94A3B8", waiting, now, pulse)
  stageSection("Peer review", "#0D9488", peerReview, now, pulse)
  stageSection(unknownTitle, "#94A3B8", unknown, now, pulse)
  stageSection("Done", "#64748B", done, now, pulse)
}
.padding(10)
