/**
 * Workspace facade — opens/lists/closes the host-side terminal session
 * that runs an agent for one task. `Workspace.name` is the task id;
 * callers key on it. Backend implementations live in their own files behind
 * the shared `Adapter` interface in `workspaceAdapter.ts`; this module
 * resolves and lazy-loads the selected one, caches it per config, and exposes
 * the `workspaces` API.
 */

import type { ResolvedConfig, WorkspaceKindSetting } from "./config.ts";
import { detectHostCapabilities, type HostCapabilities } from "./host.ts";
import {
  type Adapter,
  isSignalAborted,
  type OpenSpec,
  type WorkspaceAccessHint,
  type WorkspaceCloseResult,
  type WorkspaceInterruptResult,
  type WorkspaceKind,
  type WorkspaceProbe,
} from "./workspaceAdapter.ts";

export type {
  OpenSpec,
  Workspace,
  WorkspaceAccessHint,
  WorkspaceCloseResult,
  WorkspaceInterruptResult,
  WorkspaceKind,
  WorkspaceProbe,
  WorkspaceStatus,
} from "./workspaceAdapter.ts";

export interface WorkspaceResolution {
  requested: WorkspaceKindSetting;
  resolved: WorkspaceKind;
  /** One-line explanation of why `resolved` was chosen. */
  reason: string;
}

interface ResolveArguments {
  config: ResolvedConfig;
  host: HostCapabilities;
}

export function resolveWorkspaceKind(arguments_: ResolveArguments): WorkspaceResolution {
  const { config, host } = arguments_;
  const requested = config.workspaceKind;

  if (requested !== "auto") {
    failIfBinaryUnavailable(requested, host);
    return { requested, resolved: requested, reason: `workspaceKind set to ${requested}` };
  }

  return resolveAuto({ requested, host });
}

function resolveAuto(arguments_: {
  requested: WorkspaceKindSetting;
  host: HostCapabilities;
}): WorkspaceResolution {
  const { requested, host } = arguments_;
  if (host.hasCmux) {
    return { requested, resolved: "cmux", reason: "auto: cmux available" };
  }
  if (host.hasTmux) {
    return {
      requested,
      resolved: "tmux",
      reason: "auto: cmux unavailable, falling back to tmux",
    };
  }
  throw new Error(
    "workspaceKind 'auto' could not pick a backend: neither cmux nor tmux is on PATH. Install one or set workspaceKind explicitly.",
  );
}

const HOST_CAPABILITY_BY_KIND: Record<WorkspaceKind, "hasCmux" | "hasTmux" | "hasZellij"> = {
  cmux: "hasCmux",
  tmux: "hasTmux",
  zellij: "hasZellij",
};

const ADAPTER_LOADER_BY_KIND: Record<WorkspaceKind, () => Promise<Adapter>> = {
  cmux: async () => {
    const { cmuxAdapter } = await import("./cmuxAdapter.ts");
    return cmuxAdapter;
  },
  tmux: async () => {
    const { tmuxAdapter } = await import("./tmuxAdapter.ts");
    return tmuxAdapter;
  },
  zellij: async () => {
    const { zellijAdapter } = await import("./zellijAdapter.ts");
    return zellijAdapter;
  },
};

function failIfBinaryUnavailable(kind: WorkspaceKind, host: HostCapabilities): void {
  if (!host[HOST_CAPABILITY_BY_KIND[kind]]) {
    throw new Error(
      `workspaceKind '${kind}' is set but the ${kind} binary is not on PATH. Install ${kind} or change the setting.`,
    );
  }
}

// Per-config cache: production resolves the adapter once at first use
// (loadConfig returns a frozen, cached instance); each test uses a fresh
// config object so the cache invalidates naturally between tests.
const adapterCache = new WeakMap<ResolvedConfig, Adapter>();

async function adapterFor(config: ResolvedConfig, signal?: AbortSignal): Promise<Adapter> {
  const cached = adapterCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const { resolved } = resolveWorkspaceKind({
    config,
    host: await detectHostCapabilities(signal),
  });
  const adapter = await ADAPTER_LOADER_BY_KIND[resolved]();
  adapterCache.set(config, adapter);
  return adapter;
}

async function probeWorkspaces(
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<WorkspaceProbe> {
  let raw: Awaited<ReturnType<Adapter["list"]>>;
  try {
    const adapter = await adapterFor(config, signal);
    raw = await adapter.list(signal);
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    return { kind: "unavailable", error };
  }
  if (raw === undefined) {
    return { kind: "unavailable" };
  }
  const names = new Set(raw.map((ws) => ws.name));
  const exitedNames = new Set(raw.filter((ws) => ws.state === "exited").map((ws) => ws.name));
  return exitedNames.size === 0 ? { kind: "ok", names } : { kind: "ok", names, exitedNames };
}

async function accessHintForWorkspace(
  config: ResolvedConfig,
  name: string,
  signal?: AbortSignal,
): Promise<WorkspaceAccessHint | undefined> {
  const adapter = await adapterFor(config, signal);
  return adapter.accessHint(name);
}

async function interruptWorkspace(
  config: ResolvedConfig,
  name: string,
  signal?: AbortSignal,
): Promise<WorkspaceInterruptResult> {
  const probe = await probeWorkspaces(config, signal);
  if (probe.kind === "unavailable") {
    return { kind: "unavailable", ...(probe.error === undefined ? {} : { error: probe.error }) };
  }
  if (!probe.names.has(name)) {
    return { kind: "missing" };
  }
  const result = await workspaces.close(config, name, signal);
  if (result.kind === "unavailable") {
    return result.error === undefined
      ? { kind: "unavailable" }
      : { kind: "unavailable", error: result.error };
  }
  return { kind: "interrupted" };
}

export const workspaces = {
  async open(config: ResolvedConfig, spec: OpenSpec, signal?: AbortSignal): Promise<void> {
    const adapter = await adapterFor(config, signal);
    await adapter.open(spec, signal);
  },
  probe: probeWorkspaces,
  async close(
    config: ResolvedConfig,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceCloseResult> {
    const adapter = await adapterFor(config, signal);
    return await adapter.close(name, signal);
  },
  interrupt: interruptWorkspace,
  accessHint: accessHintForWorkspace,
};
