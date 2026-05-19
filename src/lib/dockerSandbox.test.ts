import type { RunCommandOptions } from "./commandRunner.ts";
import { sandboxExists, sandboxNameFor } from "./dockerSandbox.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

describe(sandboxNameFor, () => {
  it("composes `groundcrew-<repo>-<model>` in lowercase", () => {
    expect(sandboxNameFor({ repository: "Repo-A", model: "Claude" })).toBe(
      "groundcrew-repo-a-claude",
    );
  });

  it("normalises unsafe characters to single dashes", () => {
    expect(sandboxNameFor({ repository: "repo/A_b", model: "claude!" })).toBe(
      "groundcrew-repo-a-b-claude",
    );
  });

  it("collapses runs of dashes and strips leading/trailing dashes", () => {
    expect(sandboxNameFor({ repository: "--repo--", model: "claude--" })).toBe(
      "groundcrew-repo-claude",
    );
  });
});

describe(sandboxExists, () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("returns true when the first column of an sbx ls row matches the name", async () => {
    runCommandMock.mockReturnValue("NAME STATUS\ngroundcrew-repo-a-claude running\n");

    await expect(sandboxExists("groundcrew-repo-a-claude")).resolves.toBe(true);
  });

  it("returns false when no row's first column matches", async () => {
    runCommandMock.mockReturnValue("NAME STATUS\nother-sandbox running\n");

    await expect(sandboxExists("groundcrew-repo-a-claude")).resolves.toBe(false);
  });

  it("passes the AbortSignal to runCommandAsync", async () => {
    const controller = new AbortController();
    runCommandMock.mockReturnValue("");

    await sandboxExists("foo", controller.signal);

    expect(runCommandMock).toHaveBeenCalledWith("sbx", ["ls"], { signal: controller.signal });
  });
});
