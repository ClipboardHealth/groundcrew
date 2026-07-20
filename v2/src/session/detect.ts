/**
 * Presenter detection (contracts §5, design doc §7.2). A configured presenter
 * name wins outright; otherwise the first of cmux > tmux > zellij found on PATH
 * is chosen. Detection keys on the binary being on PATH — not on a live
 * `probe()` — because a probe's empty session list must never be read as "this
 * presenter is unavailable" (CRASH-04): an installed-but-idle multiplexer is
 * exactly the case detection must accept. The chosen adapter starts its own
 * server on `open`; PATH presence is the honest install signal.
 */

import { createCmuxPresenter } from "./cmuxPresenter.js";
import type { ExecFn } from "./exec.js";
import type { Presenter } from "./presenter.js";
import { lookupExecutable, type LookupExecutable } from "./shellCommand.js";
import { createTmuxPresenter } from "./tmuxPresenter.js";
import { createZellijPresenter } from "./zellijPresenter.js";

/** The in-core presenters, in detection priority order (design doc §8). */
export const PRESENTER_NAMES = ["cmux", "tmux", "zellij"] as const;
export type PresenterName = (typeof PRESENTER_NAMES)[number];

export class PresenterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PresenterError";
  }
}

export interface DetectPresenterInput {
  /** Config `presenter` (contracts §5); when set it wins, PATH notwithstanding. */
  configured?: string;
  /** Process runner threaded into whichever adapter is built; defaults per adapter. */
  execFn?: ExecFn;
  /** PATH searched during detection; defaults to the parent `PATH`. */
  pathValue?: string;
  /** Injected executable resolver (unit tests). */
  lookup?: LookupExecutable;
}

export interface DetectedPresenter {
  name: PresenterName;
  presenter: Presenter;
}

/** Resolve which presenter to use and construct it (contracts §5, design doc §8). */
export function detectPresenter(input: DetectPresenterInput = {}): DetectedPresenter {
  const lookup = input.lookup ?? lookupExecutable;
  const pathValue = input.pathValue ?? readPath();

  if (input.configured !== undefined) {
    const name = asPresenterName(input.configured);
    return { name, presenter: build(name, input.execFn) };
  }

  for (const name of PRESENTER_NAMES) {
    if (lookup({ name, pathValue }) !== undefined) {
      return { name, presenter: build(name, input.execFn) };
    }
  }

  throw new PresenterError(
    `no session presenter found on PATH (looked for ${PRESENTER_NAMES.join(", ")}); install one or set "presenter" in the config`,
  );
}

function build(name: PresenterName, execFn: ExecFn | undefined): Presenter {
  const options = execFn === undefined ? {} : { exec: execFn };
  switch (name) {
    case "cmux": {
      return createCmuxPresenter(options);
    }
    case "tmux": {
      return createTmuxPresenter(options);
    }
    case "zellij": {
      return createZellijPresenter(options);
    }
    default: {
      /* v8 ignore next @preserve -- name is PresenterName; this arm only satisfies exhaustiveness */
      throw new PresenterError(`unknown presenter "${String(name)}"`);
    }
  }
}

function asPresenterName(value: string): PresenterName {
  const match = PRESENTER_NAMES.find((name) => name === value);
  if (match === undefined) {
    throw new PresenterError(
      `unknown presenter "${value}" (expected one of ${PRESENTER_NAMES.join(", ")})`,
    );
  }
  return match;
}

function readPath(): string {
  // oxlint-disable-next-line node/no-process-env -- PATH is the OS executable search path, read only to detect an installed presenter
  return process.env["PATH"] ?? "";
}
