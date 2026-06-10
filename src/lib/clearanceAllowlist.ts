import path from "node:path";

import { splitPathList } from "./pathList.ts";
import { readEnvironmentVariable } from "./util.ts";

const CLEARANCE_ALLOW_HOSTS_FILES = "CLEARANCE_ALLOW_HOSTS_FILES";

interface ClearanceAllowHostsFilesInput {
  defaultFile?: string | undefined;
  existingFiles?: string | undefined;
}

function groundcrewClearanceAllowHostsFile(): string {
  return path.resolve(import.meta.dirname, "..", "..", "clearance-allow-hosts");
}

export function clearanceAllowHostsFilesValue(input: ClearanceAllowHostsFilesInput = {}): string {
  const defaultFile = input.defaultFile ?? groundcrewClearanceAllowHostsFile();
  const files = [defaultFile, ...splitPathList(input.existingFiles)];
  const seen = new Set<string>();
  const uniqueFiles: string[] = [];
  for (const file of files) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    uniqueFiles.push(file);
  }
  return uniqueFiles.join(path.delimiter);
}

export function clearanceAllowHostsFilesFromEnvironment(): string {
  return clearanceAllowHostsFilesValue({
    existingFiles: readEnvironmentVariable(CLEARANCE_ALLOW_HOSTS_FILES),
  });
}
