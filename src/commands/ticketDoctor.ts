import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";

export type TicketDoctorVerdict =
  | { kind: "would-dispatch" }
  | { kind: "ineligible"; reason: string }
  | { kind: "unresolvable"; reason: string };

export interface TicketCheck {
  name: string;
  status: "ok" | "fail" | "skipped";
  detail?: string;
}

export interface TicketDoctorResult {
  ticket: string;
  title?: string;
  resolution: TicketCheck[];
  eligibility: TicketCheck[];
  verdict: TicketDoctorVerdict;
}

export interface TicketDoctorDependencies {
  config: ResolvedConfig;
  ticket: string;
  /**
   * Injected to keep `ticketDoctor` pure and easy to unit-test. Production
   * callers pass a closure that delegates to `fetchRawLinearIssue` with a
   * real `LinearClient`; tests pass a `vi.fn()` returning a fixture.
   */
  fetchRawIssue: (input: { ticket: string }) => Promise<RawLinearIssue>;
}

export async function ticketDoctor(
  dependencies: TicketDoctorDependencies,
): Promise<TicketDoctorResult> {
  const ticket = dependencies.ticket.toUpperCase();
  const resolution: TicketCheck[] = [];
  const eligibility: TicketCheck[] = [];
  try {
    const raw = await dependencies.fetchRawIssue({ ticket });
    resolution.push({
      name: "Ticket exists in Linear",
      status: "ok",
      detail: `"${raw.title}"`,
    });
    return {
      ticket,
      title: raw.title,
      resolution,
      eligibility,
      verdict: { kind: "ineligible", reason: "no checks implemented yet" },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resolution.push({ name: "Ticket exists in Linear", status: "fail", detail: message });
    return {
      ticket,
      resolution,
      eligibility,
      verdict: { kind: "unresolvable", reason: message },
    };
  }
}
