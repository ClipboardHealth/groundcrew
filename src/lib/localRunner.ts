import type { HostCapabilities } from "./host.ts";

export function assertLocalRunnerRequirements(host: HostCapabilities): void {
  if (!host.isSafehouseSupported) {
    throw new Error("groundcrew runs require macOS with Safehouse. Linux/WSL is not supported.");
  }
  if (!host.hasSafehouse) {
    throw new Error(
      "groundcrew runs require `safehouse` on PATH. Install Safehouse from https://agent-safehouse.dev/ and retry.",
    );
  }
}
