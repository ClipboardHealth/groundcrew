/**
 * Doctor rendering: a checklist where every failure names its cause (SURFACE-02).
 * `crew doctor` and `crew source doctor` share this; exit 1 when any check fails,
 * with the failing source named in its label.
 */
import type { CheckResult } from "../checks.js";

export function renderChecks(input: {
  readonly title: string;
  readonly checks: readonly CheckResult[];
}): string {
  const lines: string[] = [input.title];

  for (const check of input.checks) {
    if (check.ok) {
      lines.push(`  ok    ${check.label}`);
    } else {
      lines.push(`  FAIL  ${check.label}: ${check.detail ?? "failed"}`);
    }
  }

  const failed = input.checks.filter((check) => !check.ok);
  lines.push("");
  if (failed.length === 0) {
    lines.push(`All ${String(input.checks.length)} checks passed.`);
  } else {
    lines.push(
      `${String(failed.length)} of ${String(input.checks.length)} checks failed:`,
    );
    for (const check of failed) {
      lines.push(`  - ${check.label}`);
    }
  }

  return lines.join("\n");
}
