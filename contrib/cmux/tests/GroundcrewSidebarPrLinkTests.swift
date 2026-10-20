import Foundation
import Testing
@testable import CmuxSwiftRender

@Suite struct GroundcrewSidebarPrLinkTests {
    private let interp = SwiftViewInterpreter()

    @Test func prButtonOpensTheConfiguredTarget() throws {
        guard let path = ProcessInfo.processInfo.environment["GROUNDCREW_SIDEBAR_PATH"] else { return }
        let src = try String(contentsOfFile: path, encoding: .utf8)
        let pr406 = SwiftValue.object([
            "number": .int(406),
            "status": .string("open"),
            "url": .string("https://github.com/clipboard-health/groundcrew/pull/406"),
        ])
        let workspace = SwiftValue.object([
            "id": .string("w1"),
            "title": .string("TG-1234 do a thing"),
            "directory": .string("/Users/jason/Documents/work/repo-tg-1234"),
            "pinned": .bool(false),
            "selected": .bool(false),
            "tabs": .array([]),
            "agents": .array([]),
            "pr": pr406,
            "prs": .array([pr406]),
        ])
        let clock = SwiftValue.object(["second": .int(0), "epoch": .double(1_790_000_000)])
        let node = interp.evaluate(src, state: ["workspaces": .array([workspace]), "clock": clock])
        var urls: [String] = []
        func walk(_ n: RenderNode) {
            if let a = n.action {
                for c in a.commands {
                    if case let .openURL(u) = c { urls.append(u) }
                }
            }
            for child in n.children { walk(child) }
        }
        if let node { walk(node) }
        print("OPEN_URLS: \(urls)")
        // contrib/cmux/groundcrew.swift ships with prLinkTarget() == "github";
        // an installed copy may override it to open Linear's review UI instead.
        #expect(urls.contains("https://github.com/clipboard-health/groundcrew/pull/406"))
        #expect(!urls.contains("linear://linear.app/review/clipboard-health/groundcrew/pull/406"))
    }
}
