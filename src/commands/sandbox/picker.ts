import checkbox from "@inquirer/checkbox";

export interface ToolChoice {
  /** Recipe key (e.g. "claude", "github"). Returned in the selection. */
  key: string;
  /** Human-friendly label shown in the prompt. */
  label: string;
  /** Auth status decoration: ✓ when authenticated, ○ otherwise. */
  authenticated: boolean;
}

/**
 * Show an interactive checkbox picker so the engineer chooses which
 * tools to authenticate. Items marked `authenticated` start unchecked
 * (no need to re-auth); unauthed items start checked (default action
 * is "auth what's missing"). The returned array is the list of `key`
 * values that the engineer left checked when they confirmed.
 *
 * Extracted to its own module so tests can vi.mock it and skip stdin
 * interaction; the real implementation pulls @inquirer/checkbox.
 */
export async function pickTools(choices: readonly ToolChoice[]): Promise<readonly string[]> {
  const selected = await checkbox<string>({
    message: "Select tools to authenticate (space to toggle, enter to confirm):",
    choices: choices.map((choice) => ({
      name: `${choice.authenticated ? "✓" : "○"} ${choice.label}`,
      value: choice.key,
      checked: !choice.authenticated,
    })),
    pageSize: Math.max(choices.length, 1),
  });
  return selected;
}
