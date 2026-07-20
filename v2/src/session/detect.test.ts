import { describe, expect, it } from "vitest";

import { detectPresenter, PRESENTER_NAMES, PresenterError } from "./detect.js";
import type { ExecFn } from "./exec.js";
import type { LookupExecutable } from "./shellCommand.js";

/** A lookup that resolves only the named binaries (empty map = nothing on PATH). */
function lookupOnly(...available: string[]): LookupExecutable {
  const paths = new Map(available.map((name): [string, string] => [name, `/usr/bin/${name}`]));
  return ({ name }) => paths.get(name);
}

const nothingOnPath = lookupOnly();

const cmuxListExec: ExecFn = async () => ({
  exitCode: 0,
  stdout: JSON.stringify({
    workspaces: [{ ref: "workspace:1", title: "x", description: "groundcrew:crew-alpha" }],
  }),
  stderr: "",
  spawnFailed: false,
});

describe("detectPresenter — configured wins", () => {
  it("honors a configured presenter even when it is not on PATH", () => {
    const detected = detectPresenter({ configured: "zellij", lookup: nothingOnPath });

    expect(detected.name).toBe("zellij");
    // zellij omits setStatus (capability by omission) — proves the right adapter built.
    expect(detected.presenter.setStatus).toBeUndefined();
  });

  it("builds the cmux adapter (which implements setStatus) when configured", () => {
    const detected = detectPresenter({ configured: "cmux", lookup: nothingOnPath });

    expect(detected.name).toBe("cmux");
    expect(detected.presenter.setStatus).toBeDefined();
  });

  it("rejects an unknown configured presenter", () => {
    expect(() => detectPresenter({ configured: "screen", lookup: lookupOnly("tmux") })).toThrow(
      PresenterError,
    );
  });
});

describe("detectPresenter — PATH detection order", () => {
  it("prefers cmux over tmux and zellij when all are present", () => {
    const detected = detectPresenter({ lookup: lookupOnly("cmux", "tmux", "zellij") });

    expect(detected.name).toBe("cmux");
  });

  it("falls through to tmux when cmux is absent", () => {
    const detected = detectPresenter({ lookup: lookupOnly("tmux", "zellij") });

    expect(detected.name).toBe("tmux");
  });

  it("falls through to zellij when only zellij is present", () => {
    const detected = detectPresenter({ lookup: lookupOnly("zellij") });

    expect(detected.name).toBe("zellij");
  });

  it("throws when no presenter is on PATH", () => {
    expect(() => detectPresenter({ lookup: nothingOnPath })).toThrow(
      /no session presenter found on PATH/,
    );
  });

  it("declares exactly the three in-core presenters in priority order", () => {
    expect(PRESENTER_NAMES).toEqual(["cmux", "tmux", "zellij"]);
  });
});

describe("detectPresenter — execFn threading", () => {
  it("threads the injected execFn into the built adapter", async () => {
    const detected = detectPresenter({
      configured: "cmux",
      execFn: cmuxListExec,
      lookup: nothingOnPath,
    });
    const probe = await detected.presenter.probe();

    expect(probe.sessions).toEqual([{ name: "crew-alpha", alive: true }]);
  });
});
