// PR links open in: "linear-app" (desktop app), "linear" (browser), or "github".
func prLinkTarget() -> String {
  return "linear-app"
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

func hasStatus(_ w) -> Bool {
  if let s = w.status {
    return true
  }
  return false
}

func firstToken(_ s) -> String {
  let t = s.split(separator: " ")
  if t.isEmpty {
    return s
  }
  return t[0]
}

func lastSegment(_ s, _ sep) -> String {
  let parts = s.split(separator: sep)
  if parts.isEmpty {
    return s
  }
  return parts[parts.count - 1]
}

// Strips every ASCII letter out of `s`. Used to confirm a ticket prefix is
// alphabetic-only before it flows unescaped into a shell command — the
// interpreter has no regex or character iteration, so this is the only
// expressible charset check.
func isAlphaOnly(_ s) -> Bool {
  let s1 = s.replacingOccurrences(of: "A", with: "")
  let s2 = s1.replacingOccurrences(of: "B", with: "")
  let s3 = s2.replacingOccurrences(of: "C", with: "")
  let s4 = s3.replacingOccurrences(of: "D", with: "")
  let s5 = s4.replacingOccurrences(of: "E", with: "")
  let s6 = s5.replacingOccurrences(of: "F", with: "")
  let s7 = s6.replacingOccurrences(of: "G", with: "")
  let s8 = s7.replacingOccurrences(of: "H", with: "")
  let s9 = s8.replacingOccurrences(of: "I", with: "")
  let s10 = s9.replacingOccurrences(of: "J", with: "")
  let s11 = s10.replacingOccurrences(of: "K", with: "")
  let s12 = s11.replacingOccurrences(of: "L", with: "")
  let s13 = s12.replacingOccurrences(of: "M", with: "")
  let s14 = s13.replacingOccurrences(of: "N", with: "")
  let s15 = s14.replacingOccurrences(of: "O", with: "")
  let s16 = s15.replacingOccurrences(of: "P", with: "")
  let s17 = s16.replacingOccurrences(of: "Q", with: "")
  let s18 = s17.replacingOccurrences(of: "R", with: "")
  let s19 = s18.replacingOccurrences(of: "S", with: "")
  let s20 = s19.replacingOccurrences(of: "T", with: "")
  let s21 = s20.replacingOccurrences(of: "U", with: "")
  let s22 = s21.replacingOccurrences(of: "V", with: "")
  let s23 = s22.replacingOccurrences(of: "W", with: "")
  let s24 = s23.replacingOccurrences(of: "X", with: "")
  let s25 = s24.replacingOccurrences(of: "Y", with: "")
  let s26 = s25.replacingOccurrences(of: "Z", with: "")
  let s27 = s26.replacingOccurrences(of: "a", with: "")
  let s28 = s27.replacingOccurrences(of: "b", with: "")
  let s29 = s28.replacingOccurrences(of: "c", with: "")
  let s30 = s29.replacingOccurrences(of: "d", with: "")
  let s31 = s30.replacingOccurrences(of: "e", with: "")
  let s32 = s31.replacingOccurrences(of: "f", with: "")
  let s33 = s32.replacingOccurrences(of: "g", with: "")
  let s34 = s33.replacingOccurrences(of: "h", with: "")
  let s35 = s34.replacingOccurrences(of: "i", with: "")
  let s36 = s35.replacingOccurrences(of: "j", with: "")
  let s37 = s36.replacingOccurrences(of: "k", with: "")
  let s38 = s37.replacingOccurrences(of: "l", with: "")
  let s39 = s38.replacingOccurrences(of: "m", with: "")
  let s40 = s39.replacingOccurrences(of: "n", with: "")
  let s41 = s40.replacingOccurrences(of: "o", with: "")
  let s42 = s41.replacingOccurrences(of: "p", with: "")
  let s43 = s42.replacingOccurrences(of: "q", with: "")
  let s44 = s43.replacingOccurrences(of: "r", with: "")
  let s45 = s44.replacingOccurrences(of: "s", with: "")
  let s46 = s45.replacingOccurrences(of: "t", with: "")
  let s47 = s46.replacingOccurrences(of: "u", with: "")
  let s48 = s47.replacingOccurrences(of: "v", with: "")
  let s49 = s48.replacingOccurrences(of: "w", with: "")
  let s50 = s49.replacingOccurrences(of: "x", with: "")
  let s51 = s50.replacingOccurrences(of: "y", with: "")
  let s52 = s51.replacingOccurrences(of: "z", with: "")
  return s52.isEmpty
}

func ticketFromDirectory(_ w) -> String {
  let base = lastSegment(w.directory, "/")
  let segs = base.split(separator: "-")
  if segs.count < 2 {
    return ""
  }
  if let number = Int(segs[segs.count - 1]) {
    if segs[segs.count - 2].count <= 5 && isAlphaOnly(segs[segs.count - 2]) {
      return (segs[segs.count - 2] + "-" + segs[segs.count - 1]).uppercased()
    }
  }
  return ""
}

func ticketFromTitle(_ w) -> String {
  let segs = firstToken(w.title).split(separator: "-")
  if segs.count != 2 {
    return ""
  }
  if let number = Int(segs[1]) {
    if segs[0].count <= 5 && isAlphaOnly(segs[0]) {
      return (segs[0] + "-" + segs[1]).uppercased()
    }
  }
  return ""
}

func ticketOf(_ w) -> String {
  let fromDir = ticketFromDirectory(w)
  if fromDir != "" {
    return fromDir
  }
  return ticketFromTitle(w)
}

func hasAgents(_ w) -> Bool {
  if let ags = w.agents {
    if ags.count > 0 {
      return true
    }
  }
  return false
}

// Agent rows supersede the native pill: both describe lifecycle state, and the
// per-agent rows carry strictly more (runtime identity, one state per session).
func showsNativeStatus(_ w) -> Bool {
  if hasAgents(w) {
    return false
  }
  return hasStatus(w)
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
  if ticketOf(w) != "" {
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

func shortDir(_ d) -> String {
  let parts = d.split(separator: "/")
  if parts.count < 2 {
    return d
  }
  return parts[parts.count - 2] + "/" + parts[parts.count - 1]
}

func stateColor(_ s) -> String {
  if s.contains("fail") {
    return "#C0392B"
  }
  if s.contains("interrupt") {
    return "#B7791F"
  }
  if s.contains("needs_input") {
    return "#F59E0B"
  }
  if s.contains("resumed") {
    return "#1D4ED8"
  }
  if s.contains("done") {
    return "#166534"
  }
  if s.contains("working") {
    return "#2563EB"
  }
  if s.contains("running") {
    return "#15803D"
  }
  if s.contains("idle") {
    return "#15803D"
  }
  if s.contains("ended") {
    return "#64748B"
  }
  return "#475569"
}

func stateBackground(_ s) -> String {
  if s.contains("fail") {
    return "#C0392B14"
  }
  if s.contains("interrupt") {
    return "#B7791F14"
  }
  if s.contains("needs_input") {
    return "#F59E0B1A"
  }
  if s.contains("resumed") {
    return "#1D4ED814"
  }
  if s.contains("done") {
    return "#16653414"
  }
  if s.contains("working") {
    return "#2563EB1A"
  }
  if s.contains("running") {
    return "#15803D14"
  }
  if s.contains("idle") {
    return "#15803D14"
  }
  if s.contains("ended") {
    return "#64748B12"
  }
  return "#0000000A"
}

func stateIcon(_ s) -> String {
  if s.contains("fail") {
    return "xmark.circle.fill"
  }
  if s.contains("interrupt") {
    return "exclamationmark.triangle.fill"
  }
  if s.contains("needs_input") {
    return "exclamationmark.circle.fill"
  }
  if s.contains("done") {
    return "checkmark.circle.fill"
  }
  if s.contains("resumed") {
    return "arrow.clockwise.circle.fill"
  }
  if s.contains("running") {
    return "play.circle.fill"
  }
  if s.contains("working") {
    return "clock.arrow.circlepath"
  }
  if s.contains("idle") {
    return "pause.circle"
  }
  if s.contains("ended") {
    return "checkmark.circle"
  }
  return "circle"
}

func activeState(_ s) -> Bool {
  if s.contains("working") {
    return true
  }
  if s.contains("running") {
    return true
  }
  if s.contains("resumed") {
    return true
  }
  if s.contains("needs_input") {
    return true
  }
  return false
}

// The row's lifecycle state: the native entry when one exists, else the most
// recent agent session's own state.
func rowStateValue(_ w) -> String {
  if let s = w.status {
    return s.value
  }
  if let ags = w.agents {
    if ags.count > 0 {
      return ags[0].status
    }
  }
  return ""
}

func statusColor(_ w) -> String {
  if let s = w.status {
    if let c = s.color {
      return c
    }
    return stateColor(s.value)
  }
  return stateColor(rowStateValue(w))
}

func stateText(_ s) -> String {
  if s.contains("needs_input") {
    return "needs you"
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

// One codex process can hold two registry records: cmux keys sessions by id and
// only reconciles a superseded id back to its canonical one for claude, so a
// second id resolved for the same pid becomes a second record. Collapse by pid
// so a process renders once; records without a pid fall back to their own id
// and are never merged together. The surviving record is the one whose state is
// most worth showing, because the duplicates disagree: the stale copy commonly
// reads idle while the process is still working.
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

func bestRankForKey(_ list, _ key) -> Int {
  return list.reduce(0) { acc, b in
    if agentKey(b) == key && stateRank(b.status) > acc {
      return stateRank(b.status)
    }
    return acc
  }
}

func bestAgentIdForKey(_ list, _ key) -> String {
  let rank = bestRankForKey(list, key)
  if let f = list.first(where: { b in agentKey(b) == key && stateRank(b.status) == rank }) {
    return f.id
  }
  return ""
}

func distinctAgents(_ list) -> Array {
  return list.filter { a in bestAgentIdForKey(list, agentKey(a)) == a.id }
}

func agentName(_ a) -> String {
  if a.name != "" {
    return a.name
  }
  return a.kind
}

func agentTooltip(_ a) -> String {
  let base = agentName(a) + " · " + stateText(a.status)
  if let t = a.title {
    return base + " — " + t
  }
  return base
}

func statusIcon(_ w) -> String {
  if let s = w.status {
    if let ic = s.icon {
      return ic
    }
    return stateIcon(s.value)
  }
  return "circle"
}

func panelNumber(_ w) -> String {
  if let r = w.ref {
    return lastSegment(r, ":")
  }
  return ""
}

VStack(alignment: .leading, spacing: 8) {
  let workbench = workspaces.filter { isWorkbench($0) }
  let tasks = workspaces.filter { isTaskRow($0) }
  let pulse = clock.second % 2 == 0

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
      .background(w.selected ? "#F59E0B14" : "#2563EB12")
      .cornerRadius(8)
      .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
    }
    Divider()
  }

  Text("Groundcrew").font(.headline)
  Text(String(tasks.count) + " tasks").font(.caption).foregroundColor(.secondary)
  Divider()

  ForEach(tasks) { w in
    let lab = rowStateValue(w)
    let color = statusColor(w)
    let active = activeState(lab)
    let task = ticketOf(w).lowercased()
    HStack(spacing: 0) {
      Rectangle().fill(color).frame(width: 3)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(w.selected ? "●" : "○")
            .foregroundColor(w.selected ? "#F59E0B" : .secondary)
          if panelNumber(w) != "" {
            Text("#" + panelNumber(w))
              .font(.system(size: 10)).monospacedDigit()
              .foregroundColor("#1E293B")
          }
          Text(w.title).font(.body).bold()
          Spacer()
        }

        Text(shortDir(w.directory)).font(.caption).foregroundColor("#64748B")

        if ticketOf(w) != "" {
          Button(action: { openURL("linear://linear.app/clipboardhealth/issue/" + ticketOf(w)) }) {
            HStack(spacing: 4) {
              Image(systemName: "ticket")
              Text(ticketOf(w)).font(.caption)
            }
          }
        }

        if let pr = w.pr {
          Button(action: { openURL(prLink(pr)) }) {
            HStack(spacing: 4) {
              Image(systemName: "arrow.triangle.branch")
              Text("PR #" + String(pr.number) + " · " + pr.status).font(.caption)
            }
          }
        }

        if let ags = w.agents {
          ForEach(distinctAgents(ags)) { a in
            HStack(spacing: 6) {
              Image(systemName: agentIcon(a.kind))
                .font(.system(size: 11))
                .foregroundColor(agentColor(a.kind))
              Image(systemName: stateIcon(a.status))
                .font(.system(size: 11))
                .foregroundColor(stateColor(a.status))
                .opacity(activeState(a.status) ? (pulse ? 1.0 : 0.4) : 1.0)
              Text(stateText(a.status))
                .font(.callout).bold()
                .foregroundColor(stateColor(a.status))
              Spacer()
            }
            .help(agentTooltip(a))
          }
        }

        if showsNativeStatus(w) {
          HStack(spacing: 6) {
            Image(systemName: statusIcon(w))
              .font(.system(size: 11))
              .foregroundColor(color)
              .opacity(active ? (pulse ? 1.0 : 0.4) : 1.0)
            Text(lab).font(.callout).bold().foregroundColor(color)
            Spacer()
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(w.selected ? "#F59E0B14" : stateBackground(lab))
    .cornerRadius(8)
    .contextMenu {
      Button(action: { cmux("workspace.close", workspace_id: w.id) }) {
        Label("Close workspace", systemImage: "xmark.circle")
      }
      if task != "" {
        Button(action: { cmux("workspace.create", initial_command: "echo '→ crew cleanup " + task + "'; crew cleanup " + task + " && { cmux workspace close " + w.id + "; echo; echo '✓ cleanup finished — close this tab when done'; }", cwd: "__GROUNDCREW_DIR__", focus: true) }) {
          Label("Cleanup workspace", systemImage: "trash")
        }
      }
    }
    .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
  }
}
.padding(10)
