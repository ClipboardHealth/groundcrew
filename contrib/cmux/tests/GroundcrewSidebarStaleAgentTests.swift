import Foundation
import Testing
@testable import CmuxSwiftRender

/// Drives the user's groundcrew sidebar against synthetic agent rosters.
/// Set GROUNDCREW_SIDEBAR_PATH to the sidebar file under test.
///
/// Post row-redesign: agents no longer render a text label (idle/working/no
/// signal/needs you) — only an icon whose color/opacity/background encode
/// state. These tests inspect that icon's modifiers instead of text.
@Suite struct GroundcrewSidebarStaleAgentTests {
    private let interp = SwiftViewInterpreter()
    private static let now: Double = 1_790_000_000
    private static let codexIcon = "circle.hexagongrid.fill"
    private static let codexBrandColor = "#111827"
    private static let staleColor = "#94A3B8"

    private func source() throws -> String? {
        guard let path = ProcessInfo.processInfo.environment["GROUNDCREW_SIDEBAR_PATH"] else {
            return nil
        }
        return try String(contentsOfFile: path, encoding: .utf8)
    }

    private func agent(id: String, status: String, secondsAgo: Double) -> SwiftValue {
        .object([
            "id": .string(id),
            "kind": .string("codex"),
            "name": .string("codex"),
            "status": .string(status),
            "pid": .int(4242),
            "lastActivityAt": .double(Self.now - secondsAgo),
        ])
    }

    private func allDescendants(_ n: RenderNode) -> [RenderNode] {
        var out: [RenderNode] = [n]
        for child in n.children { out += allDescendants(child) }
        for modifier in n.modifiers {
            for child in modifier.children { out += allDescendants(child) }
        }
        return out
    }

    /// Renders one workspace with the given agent roster and returns every
    /// codex-icon node (one per deduped live agent).
    private func codexIcons(agents: [SwiftValue]) throws -> [RenderNode] {
        guard let src = try source() else { return [] }
        let workspace = SwiftValue.object([
            "id": .string("w1"),
            "title": .string("TG-1234 do a thing"),
            "directory": .string("/Users/jason/Documents/work/repo-tg-1234"),
            "pinned": .bool(false),
            "selected": .bool(false),
            "tabs": .array([]),
            "agents": .array(agents),
        ])
        let clock = SwiftValue.object([
            "second": .int(0),
            "epoch": .double(Self.now),
        ])
        guard let node = interp.evaluate(src, state: ["workspaces": .array([workspace]), "clock": clock]) else { return [] }
        return allDescendants(node).filter { $0.kind == .image && $0.systemName == Self.codexIcon }
    }

    private func opacity(_ n: RenderNode) -> Double? {
        n.modifiers.first { $0.name == "opacity" }?.firstValue.flatMap(Double.init)
    }

    private func foregroundColor(_ n: RenderNode) -> String? {
        n.modifiers.first { $0.name == "foregroundColor" }?.firstValue
    }

    private func hasAmberBackground(_ n: RenderNode) -> Bool {
        n.modifiers.contains { $0.name == "background" && ($0.firstValue ?? "default").uppercased().contains("F59E0B") }
    }

    /// The abandoned duplicate froze at "working"; the record still receiving
    /// events reached idle. The fresher record must win, rendering as the
    /// brand-colored icon at idle's reduced opacity (not the stale gray).
    @Test func freshIdleRecordBeatsAbandonedWorkingDuplicate() throws {
        guard try source() != nil else { return }
        let icons = try codexIcons(agents: [
            agent(id: "stale", status: "working", secondsAgo: 9_000),
            agent(id: "fresh", status: "idle", secondsAgo: 30),
        ])
        #expect(icons.count == 1)
        let icon = try #require(icons.first)
        #expect(foregroundColor(icon) == Self.codexBrandColor)
        let value = try #require(opacity(icon))
        #expect(value < 1.0 && value > 0.0)
    }

    /// A lone record stuck at "working" for hours is an abandoned process, not
    /// a busy one, and must not render as active work: gray icon, low opacity.
    @Test func longSilentWorkingRecordRendersAsNoSignal() throws {
        guard try source() != nil else { return }
        let icons = try codexIcons(agents: [
            agent(id: "only", status: "working", secondsAgo: 200_000),
        ])
        #expect(icons.count == 1)
        let icon = try #require(icons.first)
        #expect(foregroundColor(icon) == Self.staleColor)
        let value = try #require(opacity(icon))
        #expect(value < 0.5)
    }

    /// needs_input waits on a person, so silence is expected. Demoting it
    /// would hide the one state that requires the user to act: it must stay
    /// brand-colored (not gray) with the amber needs-input ring.
    @Test func longSilentNeedsInputStaysVisible() throws {
        guard try source() != nil else { return }
        let icons = try codexIcons(agents: [
            agent(id: "only", status: "needs_input", secondsAgo: 200_000),
        ])
        #expect(icons.count == 1)
        let icon = try #require(icons.first)
        #expect(foregroundColor(icon) != Self.staleColor)
        #expect(hasAmberBackground(icon))
    }

    /// A genuinely busy agent between hook events must stay "working"; the
    /// longest observed gap inside a live codex session was 34 minutes. It
    /// renders brand-colored, not gray.
    @Test func recentlyActiveWorkingRecordStaysWorking() throws {
        guard try source() != nil else { return }
        let icons = try codexIcons(agents: [
            agent(id: "only", status: "working", secondsAgo: 2_100),
        ])
        #expect(icons.count == 1)
        let icon = try #require(icons.first)
        #expect(foregroundColor(icon) == Self.codexBrandColor)
        #expect(!hasAmberBackground(icon))
    }
}
