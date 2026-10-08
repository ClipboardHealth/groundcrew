import Foundation
import Testing
@testable import CmuxSwiftRender

/// Drives the groundcrew sidebar's selection treatment (pink fill, pink
/// outline, bold pink title, dimmed unselected rows) against synthetic
/// workspace snapshots. Set GROUNDCREW_SIDEBAR_PATH to the sidebar file
/// under test.
@Suite struct GroundcrewSidebarSelectionTests {
    private let interp = SwiftViewInterpreter()
    private static let now: Double = 1_796_500_000

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

    private func taskWorkspace(
        ticket: String,
        selected: Bool,
        pr: SwiftValue? = nil
    ) -> SwiftValue {
        var statuses: [SwiftValue] = [statusEntry(key: "crew_ticket", value: ticket, priority: -11)]
        if pr == nil {
            statuses.append(statusEntry(key: "crew_stage", value: "waiting", priority: -10))
        }
        var fields: [String: SwiftValue] = [
            "id": .string("w-" + ticket),
            "title": .string(ticket + " selection fixture"),
            "directory": .string("/Users/jason/Documents/work/repo"),
            "pinned": .bool(false),
            "selected": .bool(selected),
            "tabs": .array([]),
            "agents": .array([]),
            "statuses": .array(statuses),
        ]
        fields["status"] = statuses.first
        if let pr {
            fields["pr"] = pr
            fields["prs"] = .array([pr])
        }
        return .object(fields)
    }

    private func workbenchWorkspace(selected: Bool) -> SwiftValue {
        .object([
            "id": .string("w-bench"),
            "title": .string("workbench fixture"),
            "directory": .string("/Users/jason/Documents/work/repo"),
            "pinned": .bool(true),
            "selected": .bool(selected),
            "tabs": .array([
                .object(["id": .string("t1"), "title": .string("shell"), "focused": .bool(true)]),
            ]),
            "agents": .array([]),
            "statuses": .array([]),
        ])
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

    /// Tappable rows: every row carries `.onTapGesture { cmux("workspace.select", ...) }`,
    /// which the interpreter stores as `node.action` rather than a modifier,
    /// and a `background` modifier, which is unique to the row container.
    private func tappableRows(_ node: RenderNode?) -> [RenderNode] {
        guard let node else { return [] }
        return allDescendants(node).filter { n in
            n.action != nil && n.modifiers.contains { $0.name == "background" }
        }
    }

    private func background(_ row: RenderNode) -> String {
        row.modifiers.first { $0.name == "background" }?.firstValue ?? ""
    }

    private func opacity(_ row: RenderNode) -> Double? {
        row.modifiers.first { $0.name == "opacity" }?.firstValue.flatMap(Double.init)
    }

    private func strokeColor(_ row: RenderNode) -> String? {
        guard let overlay = row.modifiers.first(where: { $0.name == "overlay" }) else { return nil }
        for child in overlay.children {
            for node in allDescendants(child) where node.kind == .roundedRectangle {
                if let stroke = node.modifiers.first(where: { $0.name == "stroke" }) {
                    return stroke.firstValue
                }
            }
        }
        return nil
    }

    // MARK: - No dot glyph anywhere

    @Test func noSelectionDotGlyphRendered() throws {
        guard try source() != nil else { return }
        let selected = taskWorkspace(ticket: "TG-9001", selected: true)
        let unselected = taskWorkspace(ticket: "TG-9002", selected: false)
        let rendered = texts(try render([selected, unselected, workbenchWorkspace(selected: false)]))
        #expect(!rendered.contains { $0.contains("●") || $0.contains("○") })
    }

    // MARK: - Selected task row

    @Test func selectedTaskRowHasPinkBackground() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9003", selected: true)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        #expect(background(row).uppercased().contains("EC4899"))
    }

    @Test func selectedTaskRowHasPinkOutline() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9004", selected: true)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        let color = try #require(strokeColor(row))
        #expect(color.uppercased().contains("EC4899"))
    }

    @Test func unselectedTaskRowHasNoOutline() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9005", selected: false)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        #expect(strokeColor(row) == nil)
    }

    @Test func selectedTaskRowTitleIsBoldAndPink() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9006", selected: true)
        let root = try #require(try render([w]))
        let title = try #require(allDescendants(root).first { $0.text == "TG-9006 selection fixture" })
        #expect(title.modifiers.contains { $0.name == "bold" })
        let color = title.modifiers.first { $0.name == "foregroundColor" }?.firstValue ?? ""
        #expect(color.uppercased().contains("EC4899"))
    }

    @Test func unselectedTaskRowTitleIsNotPink() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9007", selected: false)
        let root = try #require(try render([w]))
        let title = try #require(allDescendants(root).first { $0.text == "TG-9007 selection fixture" })
        let color = title.modifiers.first { $0.name == "foregroundColor" }?.firstValue ?? ""
        #expect(!color.uppercased().contains("EC4899"))
    }

    // MARK: - Opacity

    @Test func unselectedTaskRowCarriesReducedOpacity() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9008", selected: false)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        let value = try #require(opacity(row))
        #expect(value == 0.9)
    }

    @Test func selectedTaskRowCarriesFullOpacity() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9009", selected: true)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        let value = try #require(opacity(row))
        #expect(value == 1.0)
    }

    @Test func strokeOutlineIsThinnerThanTwoPoints() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9011", selected: true)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        let overlay = try #require(row.modifiers.first { $0.name == "overlay" })
        var widthToken: String?
        for child in overlay.children {
            for node in allDescendants(child) where node.kind == .roundedRectangle {
                widthToken = node.modifiers.first { $0.name == "stroke" }?.value("lineWidth")
            }
        }
        let width = try #require(widthToken.flatMap(Double.init))
        #expect(width <= 2.0)
        #expect(width > 0)
    }

    // MARK: - Selected background is distinct from every stage tint

    @Test func selectedBackgroundDiffersFromEveryStageTint() throws {
        guard try source() != nil else { return }
        let w = taskWorkspace(ticket: "TG-9010", selected: true)
        let root = try render([w])
        let row = try #require(tappableRows(root).first)
        let selectedBg = background(row).uppercased()
        let stageTints = ["#F59E0B14", "#7C3AED14", "#DC262614", "#2563EB14", "#0D948814", "#16A34A14", "#6A5ACD14", "#94A3B814", "#64748B14"]
        for tint in stageTints {
            #expect(selectedBg != tint.uppercased())
        }
        #expect(selectedBg != "#F59E0B14")
    }

    // MARK: - Selected workbench row

    @Test func selectedWorkbenchRowGetsPinkTreatment() throws {
        guard try source() != nil else { return }
        let root = try render([workbenchWorkspace(selected: true)])
        let row = try #require(tappableRows(root).first { $0.modifiers.first { m in m.name == "background" }?.firstValue?.uppercased().contains("EC4899") == true })
        #expect(background(row).uppercased().contains("EC4899"))
        #expect(strokeColor(row)?.uppercased().contains("EC4899") == true)
        #expect(opacity(row) == 1.0)
    }

    @Test func unselectedWorkbenchRowIsDimmedWithNoOutline() throws {
        guard try source() != nil else { return }
        let root = try render([workbenchWorkspace(selected: false)])
        let row = try #require(tappableRows(root).first { $0.modifiers.contains { m in m.name == "background" } })
        #expect(opacity(row) == 0.9)
        #expect(strokeColor(row) == nil)
    }
}
