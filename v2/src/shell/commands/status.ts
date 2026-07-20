/**
 * `crew status [task]`: the read model joining Run (reported) and Workspace
 * (observed), plus dispatch skip verdicts, the presenter probe, and the source
 * queue (design §10.4, contracts §7). Rendering lives in `../render/status.ts`.
 */
import type { Context } from "../context.js";
import type { Io } from "../io.js";
import { buildStatusModel } from "../render/statusModel.js";
import { renderStatusHuman, renderStatusJson } from "../render/status.js";

export async function runStatus(input: {
  readonly context: Context;
  readonly task?: string;
  readonly json: boolean;
  readonly io: Io;
}): Promise<void> {
  const model = await buildStatusModel({
    context: input.context,
    ...(input.task === undefined ? {} : { task: input.task }),
  });

  input.io.out(input.json ? renderStatusJson(model) : renderStatusHuman(model));
}
