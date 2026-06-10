import path from "node:path";

import { splitPathList } from "./pathList.ts";
import { readEnvironmentVariable } from "./util.ts";

const CLEARANCE_ALLOW_HOSTS_FILES = "CLEARANCE_ALLOW_HOSTS_FILES";

const CLEARANCE_PROXY_ENV_NAMES = [
  "CLEARANCE_ALLOW_HOSTS",
  CLEARANCE_ALLOW_HOSTS_FILES,
  "CLEARANCE_ALLOW_PORTS",
  "CLEARANCE_ALLOW_PRIVATE_IPS",
  "CLEARANCE_DNS_TTL_MS",
  "CLEARANCE_IDLE_TIMEOUT_MS",
  "CLEARANCE_MAX_SOCKETS",
  "HOME",
  "PATH",
  "XDG_CACHE_HOME",
] as const;

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

export function clearanceProxyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CLEARANCE_PROXY_ENV_NAMES) {
    const value = readEnvironmentVariable(name);
    if (value === undefined) {
      continue;
    }
    env[name] = value;
  }
  env[CLEARANCE_ALLOW_HOSTS_FILES] = clearanceAllowHostsFilesValue({
    existingFiles: env[CLEARANCE_ALLOW_HOSTS_FILES],
  });
  return env;
}
