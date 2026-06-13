import { z } from "zod";

import { shellAdapterConfigSchema } from "./adapters/shell/schema.ts";

interface SourceCapabilities {
  verify: boolean;
  listTasks: boolean;
  getTask: boolean;
  createTask: boolean;
  markInProgress: boolean;
  markInReview: boolean;
  markDone: boolean;
  validate: boolean;
}

export interface SourceSummary {
  name: string;
  kind: string;
  capabilities: SourceCapabilities;
}

const nameShape = z.looseObject({ name: z.string().optional() });
const kindShape = z.object({ kind: z.string() });

const LINEAR_CAPABILITIES: SourceCapabilities = {
  verify: true,
  listTasks: true,
  getTask: true,
  createTask: false,
  markInProgress: true,
  markInReview: true,
  markDone: false,
  validate: false,
};

const UNKNOWN_KIND_CAPABILITIES: SourceCapabilities = {
  verify: false,
  listTasks: true,
  getTask: false,
  createTask: false,
  markInProgress: false,
  markInReview: false,
  markDone: false,
  validate: false,
};

function shellCapabilities(raw: unknown): SourceCapabilities {
  const config = shellAdapterConfigSchema.parse(raw);
  const { commands } = config;
  return {
    verify: commands.verify !== undefined,
    listTasks: true,
    getTask: true,
    createTask: commands.createTask !== undefined,
    markInProgress: commands.markInProgress !== undefined,
    markInReview: commands.markInReview !== undefined,
    markDone: commands.markDone !== undefined,
    validate: commands.validate !== undefined,
  };
}

const TODO_TXT_CAPABILITIES: SourceCapabilities = {
  verify: true,
  listTasks: true,
  getTask: true,
  createTask: true,
  markInProgress: true,
  markInReview: true,
  markDone: true,
  validate: true,
};

export function summarizeSource(raw: unknown): SourceSummary {
  const { kind } = kindShape.parse(raw);
  const { name } = nameShape.parse(raw);
  const sourceName = name ?? kind;

  let capabilities: SourceCapabilities;
  if (kind === "linear") {
    capabilities = LINEAR_CAPABILITIES;
  } else if (kind === "shell") {
    capabilities = shellCapabilities(raw);
  } else if (kind === "todo-txt") {
    capabilities = TODO_TXT_CAPABILITIES;
  } else {
    capabilities = UNKNOWN_KIND_CAPABILITIES;
  }

  return { name: sourceName, kind, capabilities };
}

export function sourceSupportsMarkDone(arguments_: {
  rawSources: readonly unknown[];
  sourceName: string;
}): boolean {
  const { rawSources, sourceName } = arguments_;
  for (const rawSource of rawSources) {
    const source = summarizeSource(rawSource);
    if (source.name === sourceName) {
      return source.capabilities.markDone;
    }
  }
  return false;
}

export function taskSupportsCompletionCommand(arguments_: {
  rawSources: readonly unknown[];
  taskId: string;
}): boolean {
  const { rawSources, taskId } = arguments_;
  const colonIndex = taskId.indexOf(":");
  if (colonIndex === -1) {
    const [singleSource] = rawSources;
    if (rawSources.length === 1 && singleSource !== undefined) {
      return summarizeSource(singleSource).capabilities.markDone;
    }
    return false;
  }
  return sourceSupportsMarkDone({
    rawSources,
    sourceName: taskId.slice(0, colonIndex),
  });
}
