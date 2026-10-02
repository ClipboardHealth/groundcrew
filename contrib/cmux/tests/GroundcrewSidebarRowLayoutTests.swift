import Foundation
import Testing
@testable import CmuxSwiftRender

/// Drives the groundcrew sidebar's redesigned task row (title + horizontal
/// agent-icon strip on line 1, ticket/PR pills on line 2) against synthetic
/// workspace snapshots. The per-row stage badge, directory line, per-agent
/// text rows, and native status line were all removed in favor of the
/// section header (stage) and a compact icon strip (agents). Set
/// GROUNDCREW_SIDEBAR_PATH to the sidebar file under test.
@Suite struct GroundcrewSidebarRowLayoutTests {
    private let interp = SwiftViewInterpreter()
    private static let now: Double = 1_796_000_000

    private func source() throws -> String? {
        guard let path = ProcessInfo.processInfo.environment["GROUNDCREW_SIDEBAR_PATH"] else {
            return nil
        }
        return try String(contentsOfFile: path, encoding: .utf8)
    }

    private func statusEntry(key: String, value: String, priority: Int) -> SwiftValue {
        .object([
            "key": .string(key),
            "value": .string(value),
            "priority": .int(priority),
            "format": .string("state"),
        ])
    }

    private func crewStage(_ slug: String) -> SwiftValue {
        statusEntry(key: "crew_stage", value: slug, priority: -10)
    }

    private func pr(url: String, number: Int = 406, status: String = "open") -> SwiftValue {
        .object(["number": .int(number), "status": .string(status), "url": .string(url)])
    }

    private func agent(id: String, kind: String, status: String, secondsAgo: Double, pid: Int) -> SwiftValue {
        .object([
            "id": .string(id),
            "kind": .string(kind),
            "name": .string(kind),
            "status": .string(status),
            "pid": .int(pid),
            "lastActivityAt": .double(Self.now - secondsAgo),
        ])
    }

    private func workspace(
        ticket: String,
        directory: String = "/Users/jason/Documents/work/repo",
        statuses: [SwiftValue] = [],
        pr: SwiftValue? = nil,
        agents: [SwiftValue] = []
    ) -> SwiftValue {
        var allStatuses = statuses
        allStatuses.append(statusEntry(key: "crew_ticket", value: ticket, priority: -11))
        var fields: [String: SwiftValue] = [
            "id": .string("w-" + ticket),
            "title": .string(ticket + " row layout fixture"),
            "directory": .string(directory),
            "pinned": .bool(false),
            "selected": .bool(false),
            "tabs": .array([]),
            "agents": .array(agents),
            "statuses": .array(allStatuses),
        ]
        if let first = allStatuses.first { fields["status"] = first }
        if let pr { fields["pr"] = pr }
        return .object(fields)
    }

    private func pollerHeartbeatWorkspace() -> SwiftValue {
        .object([
            "id": .string("w-poller"),
            "title": .string("crew-pr-stages"),
            "directory": .string("/Users/jason/Documents/work/groundcrew"),
            "pinned": .bool(false),
            "selected": .bool(false),
            "tabs": .array([]),
            "agents": .array([]),
            "statuses": .array([statusEntry(key: "crew_poller_heartbeat", value: "\(Int(Self.now - 5))", priority: -12)]),
        ])
    }

    private func render(_ workspaces: [SwiftValue]) throws -> RenderNode? {
        guard let src = try source() else { return nil }
        let all = workspaces + [pollerHeartbeatWorkspace()]
        let clock = SwiftValue.object(["second": .int(0), "epoch": .double(Self.now)])
        return interp.evaluate(src, state: ["workspaces": .array(all), "clock": clock])
    }

    private func allDescendants(_ n: RenderNode) -> [RenderNode] {
        var out: [RenderNode] = [n]
        for child in n.children { out += allDescendants(child) }
        for modifier in n.modifiers {
            for child in modifier.children { out += allDescendants(child) }
        }
        return out
    }

    private func texts(_ node: RenderNode?) -> [String] {
        guard let node else { return [] }
        return allDescendants(node).compactMap(\.text)
    }

    private func images(_ node: RenderNode?) -> [RenderNode] {
        guard let node else { return [] }
        return allDescendants(node).filter { $0.kind == .image }
    }

    /// The agent-icon strip: an HStack whose direct children are all images.
    private func agentIconContainers(_ node: RenderNode?) -> [RenderNode] {
        guard let node else { return [] }
        return allDescendants(node).filter { n in
            n.kind == .hstack && !n.children.isEmpty && n.children.allSatisfy { $0.kind == .image }
        }
    }

    // MARK: - Per-row stage badge and directory line are gone

    @Test func rowRendersNoPerRowStageBadgeText() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8001",
            statuses: [crewStage("ready_to_merge")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/8001")
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Ready to merge (1)"))
        #expect(!rendered.contains("Ready to merge"))
    }

    @Test func rowRendersNoDirectoryText() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8002",
            directory: "/Users/jason/Documents/work/some-repo",
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/8002")
        )
        let rendered = texts(try render([w]))
        #expect(!rendered.contains("work/some-repo"))
        #expect(!rendered.contains("/Users/jason/Documents/work/some-repo"))
    }

    // MARK: - Native status line is gone

    @Test func rowRendersNoNativeStatusValueText() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8003",
            statuses: [statusEntry(key: "codex", value: "Running", priority: 30)],
            agents: [agent(id: "a1", kind: "codex", status: "idle", secondsAgo: 10, pid: 1)]
        )
        let rendered = texts(try render([w]))
        #expect(!rendered.contains("Running"))
    }

    // MARK: - Agent rows carry no state text

    @Test func agentIconsRenderNoStateText() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8004",
            agents: [
                agent(id: "a1", kind: "claude", status: "idle", secondsAgo: 10, pid: 1),
                agent(id: "a2", kind: "codex", status: "working", secondsAgo: 10, pid: 2),
                agent(id: "a3", kind: "gemini", status: "needs_input", secondsAgo: 10, pid: 3),
            ]
        )
        let rendered = texts(try render([w]))
        #expect(!rendered.contains("idle"))
        #expect(!rendered.contains("working"))
        #expect(!rendered.contains("needs you"))
    }

    // MARK: - Agent icons: one per deduped agent, in a single horizontal container

    @Test func agentsRenderOneIconEachInSingleHorizontalContainerWithDedup() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8005",
            agents: [
                agent(id: "a1", kind: "claude", status: "idle", secondsAgo: 50, pid: 11),
                agent(id: "a2", kind: "codex", status: "working", secondsAgo: 500, pid: 22),
                agent(id: "a3", kind: "codex", status: "needs_input", secondsAgo: 10, pid: 22),
                agent(id: "a4", kind: "gemini", status: "idle", secondsAgo: 20, pid: 33),
            ]
        )
        let root = try render([w])
        let containers = agentIconContainers(root)
        #expect(containers.count == 1)
        let container = try #require(containers.first)
        #expect(container.children.count == 3)
        let names = Set(container.children.compactMap(\.systemName))
        #expect(names == Set(["sparkles", "circle.hexagongrid.fill", "diamond.fill"]))
    }

    @Test func needsInputAgentIconCarriesAmberTreatment() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8006",
            agents: [agent(id: "a1", kind: "gemini", status: "needs_input", secondsAgo: 10, pid: 1)]
        )
        let root = try render([w])
        let icon = try #require(images(root).first { $0.systemName == "diamond.fill" })
        let amberBackground = icon.modifiers.first { $0.name == "background" && ($0.firstValue ?? "").uppercased().contains("F59E0B") }
        #expect(amberBackground != nil)
    }

    @Test func idleAgentIconHasReducedOpacity() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8007",
            agents: [agent(id: "a1", kind: "claude", status: "idle", secondsAgo: 10, pid: 1)]
        )
        let root = try render([w])
        let icon = try #require(images(root).first { $0.systemName == "sparkles" })
        let opacityModifier = icon.modifiers.first { $0.name == "opacity" }
        let value = try #require(opacityModifier?.firstValue.flatMap(Double.init))
        #expect(value < 1.0)
        #expect(value > 0.0)
    }

    @Test func staleAgentIconIsGrayAndLowOpacity() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-8008",
            agents: [agent(id: "a1", kind: "codex", status: "working", secondsAgo: 200_000, pid: 1)]
        )
        let root = try render([w])
        let icon = try #require(images(root).first { $0.systemName == "circle.hexagongrid.fill" })
        let colorModifier = icon.modifiers.first { $0.name == "foregroundColor" }
        let colorValue: String = colorModifier?.firstValue ?? ""
        #expect(colorValue.uppercased().contains("94A3B8"))
        let opacityModifier = icon.modifiers.first { $0.name == "opacity" }
        let value = try #require(opacityModifier?.firstValue.flatMap(Double.init))
        #expect(value < 0.5)
    }

    // MARK: - Line 2 omits pieces that don't exist

    @Test func captionLineOmitsMissingPr() throws {
        guard try source() != nil else { return }
        let w = workspace(ticket: "TG-8009")
        let rendered = texts(try render([w]))
        #expect(rendered.contains("TG-8009"))
        #expect(!rendered.contains { $0.hasPrefix("PR #") })
    }

    @Test func captionLineOmitsMissingTicketPill() throws {
        guard try source() != nil else { return }
        let w = workspace(ticket: "", pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/8010"))
        let rendered = texts(try render([w]))
        #expect(rendered.contains { $0.hasPrefix("PR #") })
    }
}
