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

func ticketFromDirectory(_ w) -> String {
  let base = lastSegment(w.directory, "/")
  let segs = base.split(separator: "-")
  if segs.count < 2 {
    return ""
  }
  if let number = Int(segs[segs.count - 1]) {
    if segs[segs.count - 2].count <= 5 {
      return (segs[segs.count - 2] + "-" + segs[segs.count - 1]).uppercased()
    }
  }
  return ""
}

func ticketFromTitle(_ w) -> String {
  let segs = firstToken(w.title).split(separator: "-")
  if segs.count < 2 {
    return ""
  }
  if let number = Int(segs[1]) {
    if segs[0].count <= 5 {
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

func isTask(_ w) -> Bool {
  if hasPR(w) {
    return true
  }
  if hasStatus(w) {
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
  return "#475569"
}

func stateBackground(_ s) -> String {
  if s.contains("fail") {
    return "#C0392B14"
  }
  if s.contains("interrupt") {
    return "#B7791F14"
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
  return "#0000000A"
}

func stateIcon(_ s) -> String {
  if s.contains("fail") {
    return "xmark.circle.fill"
  }
  if s.contains("interrupt") {
    return "exclamationmark.triangle.fill"
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
  return false
}

func statusValue(_ w) -> String {
  if let s = w.status {
    return s.value
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
  return "#475569"
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
    let lab = statusValue(w)
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
          Button(action: { openURL(pr.url) }) {
            HStack(spacing: 4) {
              Image(systemName: "arrow.triangle.branch")
              Text("PR #" + String(pr.number) + " · " + pr.status).font(.caption)
            }
          }
        }

        if hasStatus(w) {
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
        Button(action: { cmux("workspace.create", initial_command: "echo '→ crew cleanup " + task + " --force'; crew cleanup " + task + " --force && cmux workspace close " + w.id + "; echo; echo '✓ cleanup finished — close this tab when done'", cwd: "__GROUNDCREW_DIR__", focus: true) }) {
          Label("Cleanup workspace", systemImage: "trash")
        }
      }
    }
    .onTapGesture { cmux("workspace.select", workspace_id: w.id) }
  }
}
.padding(10)
