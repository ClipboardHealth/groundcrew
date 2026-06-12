export interface SafehouseCmuxIntegrationFixture {
  addDirsReadOnly: readonly string[];
  claudeCommandPrelude: string;
  envPass: readonly string[];
  unreviewedEnvNames: readonly string[];
}

export function safehouseCmuxIntegrationFixture(
  overrides: Partial<SafehouseCmuxIntegrationFixture> = {},
): SafehouseCmuxIntegrationFixture {
  return {
    addDirsReadOnly: ["/Applications/cmux.app", "/Users/dev/.local/state/cmux"],
    claudeCommandPrelude: "export CMUX_CUSTOM_CLAUDE_PATH=/Users/dev/.local/bin/claude",
    envPass: ["CMUX_SURFACE_ID", "CMUX_SOCKET_PATH"],
    unreviewedEnvNames: [],
    ...overrides,
  };
}
