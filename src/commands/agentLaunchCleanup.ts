import { errorMessage, log } from "../lib/util.ts";

export function cleanupAgentLaunchBestEffort(arguments_: {
  cleanup: (() => void) | undefined;
  context: string;
}): void {
  try {
    arguments_.cleanup?.();
  } catch (error) {
    log(`Agent launch cleanup failed during ${arguments_.context}: ${errorMessage(error)}`);
  }
}
