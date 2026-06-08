import { z } from "zod";

import { shellAdapterConfigSchema } from "./adapters/shell/schema.ts";
import { kindShape } from "./buildSources.ts";

interface SourceCapabilities {
  verify: boolean;
  listTasks: boolean;
  getTask: boolean;
  createTask: boolean;
  markInProgress: boolean;
  markInReview: boolean;
  markDone: boolean;
}

export interface SourceSummary {
  name: string;
  kind: string;
  capabilities: SourceCapabilities;
}

const nameShape = z.looseObject({ name: z.string().optional() });

const LINEAR_CAPABILITIES: SourceCapabilities = {
  verify: true,
  listTasks: true,
  getTask: true,
  createTask: false,
  markInProgress: true,
  markInReview: true,
  markDone: false,
};

const UNKNOWN_KIND_CAPABILITIES: SourceCapabilities = {
  verify: false,
  listTasks: true,
  getTask: false,
  createTask: false,
  markInProgress: false,
  markInReview: false,
  markDone: false,
};

function shellCapabilities(raw: unknown): SourceCapabilities {
  const config = shellAdapterConfigSchema.parse(raw);
  const { commands } = config;
  return {
    verify: commands.verify !== undefined,
    listTasks: true,
    getTask: true,
    createTask: false,
    markInProgress: commands.markInProgress !== undefined,
    markInReview: commands.markInReview !== undefined,
    markDone: commands.markDone !== undefined,
  };
}

export function summarizeSource(raw: unknown): SourceSummary {
  const { kind } = kindShape.parse(raw);
  const { name } = nameShape.parse(raw);
  const sourceName = name ?? kind;

  let capabilities: SourceCapabilities;
  if (kind === "linear") {
    capabilities = LINEAR_CAPABILITIES;
  } else if (kind === "shell") {
    capabilities = shellCapabilities(raw);
  } else {
    capabilities = UNKNOWN_KIND_CAPABILITIES;
  }

  return { name: sourceName, kind, capabilities };
}
