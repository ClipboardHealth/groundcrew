import Foundation
import Testing
@testable import CmuxSwiftRender

/// Drives the groundcrew sidebar's PR review-pipeline stage logic (badges,
/// section grouping, the stale-poller caption, the feature-off degradation
/// when `cmux.prStages` has never run, and the `crew stage` context-menu
/// actions) against synthetic workspace snapshots.
/// Set GROUNDCREW_SIDEBAR_PATH to the sidebar file under test.
///
/// Contract (post-optimization): crew_stage carries a bare slug (no epoch —
/// freshness is a single crew_poller_heartbeat status pr-stage-sync writes on
/// its OWN workspace each pass, not per crew_stage entry). crew_labels
/// carries a comma-joined subset of {self-reviewed, tested}, driving the
/// context menu's toggle actions. A workspace set with NO
/// crew_poller_heartbeat anywhere means cmux.prStages is disabled for every
/// tracked task (not merely stale): the stale caption hides and the
/// "Stage unknown" section becomes "Open PRs".
@Suite struct GroundcrewSidebarStageTests {
    private let interp = SwiftViewInterpreter()
    private static let now: Double = 1_793_000_000

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

    private func crewLabels(_ labels: String) -> SwiftValue {
        statusEntry(key: "crew_labels", value: labels, priority: -13)
    }

    private func pr(url: String, number: Int = 406, status: String = "open") -> SwiftValue {
        .object(["number": .int(number), "status": .string(status), "url": .string(url)])
    }

    private func agent(id: String, status: String, secondsAgo: Double, pid: Int = Int.random(in: 1...999_999)) -> SwiftValue {
        .object([
            "id": .string(id),
            "kind": .string("codex"),
            "name": .string("codex"),
            "status": .string(status),
            "pid": .int(pid),
            "lastActivityAt": .double(Self.now - secondsAgo),
        ])
    }

    /// `crewTicket` reads the poller-written crew_ticket status, which is what
    /// makes a PR-less, status-less, agent-less workspace still count as a
    /// task row (the ticket-from-title/directory parsing moved to the poller).
    private func workspace(
        ticket: String,
        statuses: [SwiftValue] = [],
        pr: SwiftValue? = nil,
        agents: [SwiftValue] = []
    ) -> SwiftValue {
        var allStatuses = statuses
        allStatuses.append(statusEntry(key: "crew_ticket", value: ticket, priority: -11))
        var fields: [String: SwiftValue] = [
            "id": .string("w-" + ticket),
            "title": .string(ticket + " sidebar stage fixture"),
            "directory": .string("/Users/jason/Documents/work/repo"),
            "pinned": .bool(false),
            "selected": .bool(false),
            "tabs": .array([]),
            "agents": .array(agents),
            "statuses": .array(allStatuses),
        ]
        if let first = allStatuses.first { fields["status"] = first }
        if let pr {
            fields["pr"] = pr
        }
        return .object(fields)
    }

    private func pollerHeartbeatWorkspace(secondsAgo: Double) -> SwiftValue {
        .object([
            "id": .string("w-poller"),
            "title": .string("crew-pr-stages"),
            "directory": .string("/Users/jason/Documents/work/groundcrew"),
            "pinned": .bool(false),
            "selected": .bool(false),
            "tabs": .array([]),
            "agents": .array([]),
            "statuses": .array([statusEntry(key: "crew_poller_heartbeat", value: "\(Int(Self.now - secondsAgo))", priority: -12)]),
        ])
    }

    /// `heartbeatSecondsAgo` models the poller's single per-pass heartbeat:
    /// `5` (default) is fresh, `900` is stale, `nil` omits it entirely (the
    /// poller has never run in this snapshot).
    private func render(_ workspaces: [SwiftValue], heartbeatSecondsAgo: Double? = 5) throws -> RenderNode? {
        guard let src = try source() else { return nil }
        var all = workspaces
        if let heartbeatSecondsAgo {
            all.append(pollerHeartbeatWorkspace(secondsAgo: heartbeatSecondsAgo))
        }
        let clock = SwiftValue.object(["second": .int(0), "epoch": .double(Self.now)])
        return interp.evaluate(src, state: ["workspaces": .array(all), "clock": clock])
    }

    /// Walks a node's children AND its modifiers' children — `.contextMenu { }`,
    /// nested `Menu { }`, `.overlay { }`, etc. carry their trailing-closure
    /// subtree on the modifier/node itself, so this must descend both.
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

    private func cmuxCommands(_ node: RenderNode?) -> [(method: String, params: [String: String])] {
        guard let node else { return [] }
        var out: [(method: String, params: [String: String])] = []
        for n in allDescendants(node) {
            guard let action = n.action else { continue }
            for c in action.commands {
                if case let .cmux(method, params) = c { out.append((method, params)) }
            }
        }
        return out
    }

    // MARK: - Rule order (first match wins)

    @Test func needsInputAgentOutranksFreshCrewStage() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4001",
            statuses: [crewStage("ready_to_merge")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/1"),
            agents: [agent(id: "a1", status: "needs_input", secondsAgo: 30)]
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Needs you (1)"))
        #expect(!rendered.contains("Ready to merge (1)"))
    }

    @Test func executingAgentOutranksFreshCrewStage() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4002",
            statuses: [crewStage("changes_requested")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/2"),
            agents: [agent(id: "a2", status: "working", secondsAgo: 30)]
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Working (1)"))
        #expect(!rendered.contains("Changes requested (1)"))
    }

    @Test func abandonedDuplicateWorkingRecordDoesNotMakeRowWorking() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4009",
            statuses: [crewStage("my_review")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/9"),
            agents: [
                agent(id: "abandoned", status: "working", secondsAgo: 600, pid: 4242),
                agent(id: "current", status: "idle", secondsAgo: 5, pid: 4242),
            ]
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Your review (1)"))
        #expect(!rendered.contains("Working (1)"))
    }

    @Test func freshCiRunningStageRendersAsWorking() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4003",
            statuses: [crewStage("ci_running")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/3")
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Working (1)"))
    }

    @Test func freshCrewStageSlugRendersItsOwnBadge() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4004",
            statuses: [crewStage("peer_review")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/4")
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Peer review (1)"))
    }

    @Test func staleHeartbeatWithCrewStageIsUnknown() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4005",
            statuses: [crewStage("my_review")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5")
        )
        let rendered = texts(try render([w], heartbeatSecondsAgo: 900))
        #expect(rendered.contains("Stage unknown (1)"))
        #expect(!rendered.contains("Your review (1)"))
    }

    /// No workspace carries a heartbeat anywhere in this snapshot — in
    /// practice that only happens when cmux.prStages has never run for any
    /// tracked task, since pr-stage-sync writes the heartbeat on every pass
    /// that also writes a crew_stage. The feature-off section title wins
    /// over "Stage unknown" even on a row that happens to carry a stale
    /// crew_stage value.
    @Test func noHeartbeatAtAllRendersUnderOpenPrsNotStageUnknown() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4005B",
            statuses: [crewStage("my_review")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5")
        )
        let rendered = texts(try render([w], heartbeatSecondsAgo: nil))
        #expect(rendered.contains("Open PRs (1)"))
        #expect(!rendered.contains("Stage unknown (1)"))
    }

    @Test func missingCrewStageWithPrIsUnknown() throws {
        guard try source() != nil else { return }
        let w = workspace(ticket: "TG-4006", pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/6"))
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Stage unknown (1)"))
    }

    @Test func workspaceWithNoPrIsWaiting() throws {
        guard try source() != nil else { return }
        let w = workspace(ticket: "TG-4007")
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Waiting (1)"))
        #expect(!rendered.contains("Stage unknown (1)"))
    }

    // MARK: - crew_stage/crew_ticket/crew_labels must never leak into the native lifecycle pill

    /// When crew_stage is the workspace's ONLY status entry, it is also
    /// `w.status` (the first/highest-priority entry) — the exact trap the
    /// sidebar's `hasStatus` guards against for every poller-managed key.
    @Test func soleCrewStageStatusNeverRendersAsNativeLifecyclePill() throws {
        guard try source() != nil else { return }
        let w = workspace(
            ticket: "TG-4008",
            statuses: [crewStage("my_review")],
            pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/8")
        )
        let rendered = texts(try render([w]))
        #expect(rendered.contains("Your review (1)"))
        #expect(!rendered.contains(where: { $0.contains("my_review") }))
    }

    @Test func soleCrewTicketStatusDoesNotAlsoRenderAsNativeLifecyclePill() throws {
        guard try source() != nil else { return }
        // No crew_stage, no PR, no agents: crew_ticket is the workspace's only
        // status entry (so w.status resolves to it). If hasStatus failed to
        // exclude it, the fallback native-pill Text would render the SAME
        // ticket string a second time (lab == w.status.value == the ticket).
        let w = workspace(ticket: "TG-4009")
        let rendered = texts(try render([w]))
        #expect(rendered.filter { $0 == "TG-4009" }.count == 1)
    }

    // MARK: - Section grouping and order

    @Test func sectionsRenderInSpecifiedOrderWithHiddenEmptySections() throws {
        guard try source() != nil else { return }
        let workspaces = [
            workspace(ticket: "TG-5001", agents: [agent(id: "n1", status: "needs_input", secondsAgo: 10)]),
            workspace(
                ticket: "TG-5002",
                statuses: [crewStage("my_review")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5002")
            ),
            workspace(
                ticket: "TG-5003",
                statuses: [crewStage("ci_failing")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5003")
            ),
            workspace(
                ticket: "TG-5004",
                statuses: [crewStage("changes_requested")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5004")
            ),
            workspace(
                ticket: "TG-5005",
                statuses: [crewStage("needs_testing")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5005")
            ),
            workspace(
                ticket: "TG-5006",
                statuses: [crewStage("peer_review")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5006")
            ),
            workspace(
                ticket: "TG-5007",
                statuses: [crewStage("ready_to_merge")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5007")
            ),
            workspace(ticket: "TG-5008", agents: [agent(id: "n8", status: "working", secondsAgo: 10)]),
            workspace(ticket: "TG-5009"),
            workspace(ticket: "TG-5010", pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5010")),
            workspace(
                ticket: "TG-5011",
                statuses: [crewStage("merged")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/5011")
            ),
        ]
        let rendered = texts(try render(workspaces))

        let expectedHeadersInOrder = [
            "Needs you (1)",
            "Your review (1)",
            "CI failing (1)",
            "Changes requested (1)",
            "Needs testing (1)",
            "Ready to merge (1)",
            "Working (1)",
            "Waiting (1)",
            "Peer review (1)",
            "Stage unknown (1)",
            "Done (1)",
        ]
        let indices = expectedHeadersInOrder.map { rendered.firstIndex(of: $0) }
        #expect(indices.allSatisfy { $0 != nil })
        let resolved = indices.compactMap { $0 }
        #expect(resolved == resolved.sorted())
        #expect(resolved.count == expectedHeadersInOrder.count)
    }

    // MARK: - Stale-poller caption (heartbeat-driven)

    @Test func captionAppearsWhenHeartbeatIsStale() throws {
        guard try source() != nil else { return }
        let workspaces = [
            workspace(ticket: "TG-6001", pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/6001")),
            workspace(
                ticket: "TG-6002",
                statuses: [crewStage("merged")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/6002")
            ),
        ]
        let rendered = texts(try render(workspaces, heartbeatSecondsAgo: 900))
        #expect(rendered.contains("PR stages stale — is crew-pr-stages running?"))
    }

    /// No heartbeat anywhere means the feature has never run for anyone, not
    /// that it broke — the stale caption would be a false alarm for a user
    /// who never opted into cmux.prStages, so it must stay hidden.
    @Test func captionHiddenWhenNoHeartbeatWorkspaceExists() throws {
        guard try source() != nil else { return }
        let workspaces = [
            workspace(ticket: "TG-6001B", pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/6001")),
        ]
        let rendered = texts(try render(workspaces, heartbeatSecondsAgo: nil))
        #expect(!rendered.contains("PR stages stale — is crew-pr-stages running?"))
        #expect(rendered.contains("Open PRs (1)"))
    }

    @Test func captionHiddenWhenHeartbeatIsFresh() throws {
        guard try source() != nil else { return }
        let workspaces = [
            workspace(ticket: "TG-6003", pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/6003")),
            workspace(
                ticket: "TG-6004",
                statuses: [crewStage("my_review")],
                pr: pr(url: "https://github.com/clipboard-health/groundcrew/pull/6004")
            ),
        ]
        let rendered = texts(try render(workspaces, heartbeatSecondsAgo: 5))
        #expect(!rendered.contains("PR stages stale — is crew-pr-stages running?"))
    }

    // MARK: - Context menu: self-review / testing toggles (crew_labels-driven)

    @Test func statusActionsSitAtContextMenuRootWithoutSubmenu() throws {
        guard try source() != nil else { return }
        let url = "https://github.com/clipboard-health/groundcrew/pull/7005"
        let w = workspace(ticket: "TG-7005", statuses: [crewStage("my_review"), crewLabels("")], pr: pr(url: url))
        let root = try #require(try render([w]))
        #expect(allDescendants(root).allSatisfy { $0.kind != .menu })
        #expect(cmuxCommands(root).contains { $0.params["initial_command"]?.contains("label-add") == true })
    }

    @Test func selfReviewToggleOffersDoneWhenLabelAbsent() throws {
        guard try source() != nil else { return }
        let url = "https://github.com/clipboard-health/groundcrew/pull/7001"
        let w = workspace(ticket: "TG-7001", statuses: [crewStage("my_review"), crewLabels("")], pr: pr(url: url))
        let commands = cmuxCommands(try render([w]))
        let initialCommands = commands.compactMap { $0.params["initial_command"] }
        #expect(initialCommands.contains { $0.contains("label-add") && $0.contains("self-reviewed") && $0.contains(url) })
        #expect(!initialCommands.contains { $0.contains("label-remove") && $0.contains("self-reviewed") })
    }

    @Test func selfReviewToggleOffersUndoWhenLabelPresent() throws {
        guard try source() != nil else { return }
        let url = "https://github.com/clipboard-health/groundcrew/pull/7002"
        let w = workspace(ticket: "TG-7002", statuses: [crewStage("needs_testing"), crewLabels("self-reviewed")], pr: pr(url: url))
        let commands = cmuxCommands(try render([w]))
        let initialCommands = commands.compactMap { $0.params["initial_command"] }
        #expect(initialCommands.contains { $0.contains("label-remove") && $0.contains("self-reviewed") && $0.contains(url) })
        #expect(!initialCommands.contains { $0.contains("label-add") && $0.contains("self-reviewed") })
    }

    @Test func testingToggleOffersDoneWhenLabelAbsent() throws {
        guard try source() != nil else { return }
        let url = "https://github.com/clipboard-health/groundcrew/pull/7003"
        let w = workspace(ticket: "TG-7003", statuses: [crewStage("needs_testing"), crewLabels("self-reviewed")], pr: pr(url: url))
        let commands = cmuxCommands(try render([w]))
        let initialCommands = commands.compactMap { $0.params["initial_command"] }
        #expect(initialCommands.contains { $0.contains("label-add") && $0.contains(" tested") && $0.contains(url) })
        #expect(!initialCommands.contains { $0.contains("label-remove") && $0.contains(" tested") })
    }

    @Test func testingToggleOffersUndoWhenLabelPresent() throws {
        guard try source() != nil else { return }
        let url = "https://github.com/clipboard-health/groundcrew/pull/7004"
        let w = workspace(
            ticket: "TG-7004",
            statuses: [crewStage("ready_to_merge"), crewLabels("self-reviewed,tested")],
            pr: pr(url: url)
        )
        let commands = cmuxCommands(try render([w]))
        let initialCommands = commands.compactMap { $0.params["initial_command"] }
        #expect(initialCommands.contains { $0.contains("label-remove") && $0.contains(" tested") && $0.contains(url) })
        #expect(!initialCommands.contains { $0.contains("label-add") && $0.contains(" tested") })
    }

    @Test func refreshStagesActionOffersOnAnyPrBearingRow() throws {
        guard try source() != nil else { return }
        let url = "https://github.com/clipboard-health/groundcrew/pull/7005"
        let w = workspace(ticket: "TG-7005", pr: pr(url: url))
        let commands = cmuxCommands(try render([w]))
        let initialCommands = commands.compactMap { $0.params["initial_command"] }
        #expect(initialCommands.contains { $0.contains("crew stage refresh") })
    }

    /// A PR URL carrying shell metacharacters must never reach a shell
    /// string, even indirectly through the always-offered refresh action or
    /// either label toggle.
    @Test func unsafePrUrlSuppressesEveryCrewStagesMenuAction() throws {
        guard try source() != nil else { return }
        let dangerous = "https://github.com/clipboard-health/groundcrew/pull/1; rm -rf /tmp"
        let w = workspace(ticket: "TG-7006", statuses: [crewStage("my_review")], pr: pr(url: dangerous))
        let commands = cmuxCommands(try render([w]))
        let initialCommands = commands.compactMap { $0.params["initial_command"] }
        #expect(!initialCommands.contains { $0.contains("crew stage") })
    }
}
