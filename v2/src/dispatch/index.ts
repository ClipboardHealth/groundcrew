/**
 * Dispatch: the per-tick picker — poll, eligibility, claim, provision, and the
 * terminal-status sweep; persists per-task skip verdicts. Wires the Writeback
 * adapter into Run (spec §9.3).
 */
export const MODULE = "dispatch";
