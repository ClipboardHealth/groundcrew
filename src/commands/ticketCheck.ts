export interface TicketCheck {
  name: string;
  status: "ok" | "fail" | "skipped";
  detail?: string;
  failureSummary?: string;
}

export interface Section {
  name: string;
  checks: TicketCheck[];
  /** When present and `checks` is empty, the section renders as `(skipped — <skipReason>)`. */
  skipReason?: string;
}

interface RenderInput {
  command: string;
  argument: string;
  title?: string;
  sections: Section[];
  verdict: string;
}

const STATUS_TAG: Record<TicketCheck["status"], string> = {
  ok: "[ok]",
  fail: "[--]",
  skipped: "[? ]",
};

function formatCheck(check: TicketCheck): string {
  const tag = STATUS_TAG[check.status];
  const detail = check.detail === undefined ? "" : ` (${check.detail})`;
  return `  ${tag} ${check.name}${detail}`;
}

function sectionLines(section: Section): string[] {
  if (section.checks.length === 0 && section.skipReason !== undefined) {
    return [section.name, `  (skipped — ${section.skipReason})`];
  }
  return [section.name, ...section.checks.map(formatCheck)];
}

export function renderTicketCheckResult(input: RenderInput): string[] {
  const titlePart = input.title === undefined ? "" : ` (${input.title})`;
  const header = `groundcrew ${input.command} ${input.argument}${titlePart}`;
  const bar = "─".repeat(header.length);
  const body = input.sections.flatMap((section) => ["", ...sectionLines(section)]);
  return [header, bar, ...body, "", input.verdict];
}
