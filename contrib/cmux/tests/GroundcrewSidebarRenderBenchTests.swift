import Foundation
import Testing
@testable import CmuxSwiftRender

/// Measures end-to-end parse+eval cost of a groundcrew sidebar file, the same
/// call `InProcessSidebarInterpreter.render(source:state:)` makes on every
/// 1s TimelineView tick: `SwiftViewInterpreter.evaluate(source:state:)`,
/// which reparses the source from scratch every call.
///
/// Set GROUNDCREW_BENCH_SPECS to a comma-separated list of
/// `label:path[:contract]` entries, e.g.
///   GROUNDCREW_BENCH_SPECS="live:/path/a.swift:epoch,wip:/path/b.swift:epoch"
/// `contract` is "epoch" (crew_stage="<slug> <epochSeconds>", default) or
/// "heartbeat" (crew_stage="<slug>", freshness via a separate heartbeat
/// status). Missing env var: the test is skipped, matching this suite's
/// existing sidebar tests.
@Suite struct GroundcrewSidebarRenderBenchTests {
    private let interp = SwiftViewInterpreter()
    private static let now: Double = 1_795_000_000
    private static let iterations = 10

    private struct Spec {
        let label: String
        let path: String
        let contract: String
    }

    private func specs() -> [Spec] {
        guard let raw = ProcessInfo.processInfo.environment["GROUNDCREW_BENCH_SPECS"], !raw.isEmpty else { return [] }
        return raw.split(separator: ",").compactMap { entry in
            let parts = entry.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 2 else { return nil }
            let label = parts[0]
            let path = parts[1]
            let contract = parts.count >= 3 && !parts[2].isEmpty ? parts[2] : "epoch"
            return Spec(label: label, path: path, contract: contract)
        }
    }

    // MARK: - Synthetic context (12 workspaces: 1 pinned + 11 tasks)

    private func agent(id: String, pid: Int, kind: String, status: String, secondsAgo: Double) -> SwiftValue {
        .object([
            "id": .string(id),
            "kind": .string(kind),
            "name": .string(kind),
            "status": .string(status),
            "pid": .int(pid),
            "lastActivityAt": .double(Self.now - secondsAgo),
        ])
    }

    private func statusEntry(key: String, value: String, priority: Int, color: String? = nil) -> SwiftValue {
        var fields: [String: SwiftValue] = [
            "key": .string(key),
            "value": .string(value),
            "priority": .int(priority),
            "format": .string("state"),
        ]
        if let color { fields["color"] = .string(color) }
        return .object(fields)
    }

    private func crewStageValue(_ slug: String, secondsAgo: Double, contract: String) -> String {
        if contract == "heartbeat" { return slug }
        return "\(slug) \(Int(Self.now - secondsAgo))"
    }

    private func pr(number: Int, status: String = "open") -> SwiftValue {
        .object([
            "number": .int(number),
            "status": .string(status),
            "url": .string("https://github.com/clipboard-health/groundcrew/pull/\(number)"),
        ])
    }

    /// Padding entries every real row carries alongside a crew_stage pill:
    /// a build/deploy/lint style status trio, unrelated to stage logic.
    private func paddingStatuses() -> [SwiftValue] {
        [
            statusEntry(key: "build", value: "passing", priority: 20, color: "#16A34A"),
            statusEntry(key: "lint", value: "clean", priority: 15),
            statusEntry(key: "notes", value: "reviewed once", priority: 5),
        ]
    }

    private func workspace(
        ref: String,
        ticket: String,
        directory: String? = nil,
        pinned: Bool = false,
        selected: Bool = false,
        tabs: [SwiftValue] = [],
        agents: [SwiftValue] = [],
        statuses: [SwiftValue] = [],
        pr: SwiftValue? = nil
    ) -> SwiftValue {
        var fields: [String: SwiftValue] = [
            "id": .string("w-" + ticket),
            "ref": .string(ref),
            "title": .string(ticket + " bench fixture workspace"),
            "directory": .string(directory ?? "/Users/jason/Documents/work/groundcrew-\(ticket.lowercased())"),
            "pinned": .bool(pinned),
            "selected": .bool(selected),
            "tabs": .array(tabs),
            "agents": .array(agents),
            "statuses": .array(statuses),
        ]
        if let first = statuses.first { fields["status"] = first }
        if let pr { fields["pr"] = pr }
        return .object(fields)
    }

    private func buildWorkspaces(contract: String) -> [SwiftValue] {
        let pinned = workspace(
            ref: "workspace:1",
            ticket: "PIN",
            pinned: true,
            tabs: [
                .object(["id": .string("t1"), "title": .string("shell"), "focused": .bool(true)]),
                .object(["id": .string("t2"), "title": .string("logs"), "focused": .bool(false)]),
            ]
        )

        let needsYou = workspace(
            ref: "workspace:2",
            ticket: "TG-6101",
            agents: [agent(id: "a2", pid: 201, kind: "claude", status: "needs_input", secondsAgo: 40)],
            statuses: paddingStatuses()
        )

        let workingDupPid = workspace(
            ref: "workspace:3",
            ticket: "TG-6102",
            agents: [
                agent(id: "a3a", pid: 301, kind: "codex", status: "idle", secondsAgo: 20),
                agent(id: "a3b", pid: 301, kind: "codex", status: "working", secondsAgo: 15),
                agent(id: "a3c", pid: 302, kind: "codex", status: "working", secondsAgo: 10),
            ],
            statuses: paddingStatuses()
        )

        let waiting = workspace(
            ref: "workspace:4",
            ticket: "TG-6103",
            agents: [agent(id: "a4", pid: 401, kind: "gemini", status: "idle", secondsAgo: 500)],
            statuses: paddingStatuses()
        )

        func prTask(ref: String, ticket: String, number: Int, slug: String, fresh: Bool) -> SwiftValue {
            var statuses = paddingStatuses()
            statuses.insert(
                statusEntry(
                    key: "crew_stage",
                    value: crewStageValue(slug, secondsAgo: fresh ? 5 : 900, contract: contract),
                    priority: -10
                ),
                at: 0
            )
            if contract == "heartbeat" {
                statuses.append(statusEntry(key: "crew_poller_heartbeat", value: "\(Int(Self.now - (fresh ? 5 : 900)))", priority: -12))
            }
            return workspace(
                ref: ref,
                ticket: ticket,
                agents: [agent(id: "a-\(ticket)", pid: 500 + number, kind: "claude", status: "done", secondsAgo: 3_000)],
                statuses: statuses,
                pr: pr(number: number)
            )
        }

        let myReview = prTask(ref: "workspace:5", ticket: "TG-6104", number: 5104, slug: "my_review", fresh: true)
        let ciFailing = prTask(ref: "workspace:6", ticket: "TG-6105", number: 5105, slug: "ci_failing", fresh: true)
        let changesRequested = prTask(ref: "workspace:7", ticket: "TG-6106", number: 5106, slug: "changes_requested", fresh: true)
        let needsTesting = prTask(ref: "workspace:8", ticket: "TG-6107", number: 5107, slug: "needs_testing", fresh: true)
        let peerReview = prTask(ref: "workspace:9", ticket: "TG-6108", number: 5108, slug: "peer_review", fresh: true)
        let readyToMerge = prTask(ref: "workspace:10", ticket: "TG-6109", number: 5109, slug: "ready_to_merge", fresh: true)
        let unknown = prTask(ref: "workspace:11", ticket: "TG-6110", number: 5110, slug: "ready_to_merge", fresh: false)
        let merged = prTask(ref: "workspace:12", ticket: "TG-6111", number: 5111, slug: "merged", fresh: true)

        return [
            pinned, needsYou, workingDupPid, waiting,
            myReview, ciFailing, changesRequested, needsTesting,
            peerReview, readyToMerge, unknown, merged,
        ]
    }

    // MARK: - Timing

    private func median(_ samples: [Double]) -> Double {
        let sorted = samples.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    private func millis(_ elapsed: Duration) -> Double {
        Double(elapsed.components.seconds) * 1_000 + Double(elapsed.components.attoseconds) / 1e15
    }

    private func medianMillis(source: String, workspaces: [SwiftValue]) -> Double {
        let clock = SwiftValue.object(["second": .int(0), "epoch": .double(Self.now)])
        let state: [String: SwiftValue] = ["workspaces": .array(workspaces), "clock": clock]
        var samples: [Double] = []
        samples.reserveCapacity(Self.iterations)
        for _ in 0..<Self.iterations {
            let start = ContinuousClock.now
            _ = interp.evaluate(source, state: state)
            samples.append(millis(start.duration(to: ContinuousClock.now)))
        }
        return median(samples)
    }

    /// Splits the combined parse+eval cost into its two phases, mirroring
    /// `SwiftViewInterpreter.evaluate(source:state:)`'s own
    /// `evaluate(parse(source), state:)` composition.
    private func medianParseEvalSplit(source: String, workspaces: [SwiftValue]) -> (parseMs: Double, evalMs: Double) {
        let clock = SwiftValue.object(["second": .int(0), "epoch": .double(Self.now)])
        let state: [String: SwiftValue] = ["workspaces": .array(workspaces), "clock": clock]
        var parseSamples: [Double] = []
        var evalSamples: [Double] = []
        for _ in 0..<Self.iterations {
            let parseStart = ContinuousClock.now
            let program = interp.parse(source)
            parseSamples.append(millis(parseStart.duration(to: ContinuousClock.now)))

            let evalStart = ContinuousClock.now
            _ = interp.evaluate(program, state: state)
            evalSamples.append(millis(evalStart.duration(to: ContinuousClock.now)))
        }
        return (median(parseSamples), median(evalSamples))
    }

    @Test func reportRenderMedians() throws {
        let specs = specs()
        guard !specs.isEmpty else { return }
        for spec in specs {
            guard let source = try? String(contentsOfFile: spec.path, encoding: .utf8) else {
                print("BENCH label=\(spec.label) path=\(spec.path) outcome=missing")
                continue
            }
            let workspaces = buildWorkspaces(contract: spec.contract)
            let node = interp.evaluate(source, state: ["workspaces": .array(workspaces), "clock": .object(["second": .int(0), "epoch": .double(Self.now)])])
            let median = medianMillis(source: source, workspaces: workspaces)
            let split = medianParseEvalSplit(source: source, workspaces: workspaces)
            print("BENCH label=\(spec.label) path=\(spec.path) contract=\(spec.contract) bytes=\(source.utf8.count) median_ms=\(median) parse_ms=\(split.parseMs) eval_ms=\(split.evalMs) n=\(Self.iterations) rendered=\(node != nil)")
        }
    }
}
