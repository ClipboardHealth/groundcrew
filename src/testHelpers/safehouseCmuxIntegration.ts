import type { SafehouseCmuxIntegration } from "@clipboard-health/clearance";

export function safehouseCmuxIntegrationFixture(
  overrides: Partial<SafehouseCmuxIntegration> = {},
): SafehouseCmuxIntegration {
  return {
    addDirsReadOnly: ["/Applications/cmux.app", "/Users/dev/.local/state/cmux"],
    claudeCommandPrelude: "export CMUX_CUSTOM_CLAUDE_PATH=/Users/dev/.local/bin/claude",
    envPass: ["CMUX_SURFACE_ID", "CMUX_SOCKET_PATH"],
    isActive: true,
    unreviewedEnvNames: [],
    ...overrides,
  };
}
