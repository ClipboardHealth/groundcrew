import { parseCmuxStatusLines, readCmuxStatus, writeCmuxStatus } from "./cmuxStatusFields.ts";
import type { RunCommandOptions } from "./commandRunner.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

describe(parseCmuxStatusLines, () => {
  it("parses a key=value line with no trailing attributes", () => {
    expect(parseCmuxStatusLines("crew_stage=ready_to_merge")).toStrictEqual(
      new Map([["crew_stage", "ready_to_merge"]]),
    );
  });

  it("takes the value up to the next space, ignoring trailing attrs", () => {
    expect(parseCmuxStatusLines("claude_code=Running icon=bolt.fill color=#4C8DFF")).toStrictEqual(
      new Map([["claude_code", "Running"]]),
    );
  });

  it("parses multiple lines", () => {
    expect(
      parseCmuxStatusLines("crew_stage=peer_review\ncrew_ticket=TG-1 priority=-11"),
    ).toStrictEqual(
      new Map([
        ["crew_stage", "peer_review"],
        ["crew_ticket", "TG-1"],
      ]),
    );
  });

  it("ignores blank lines", () => {
    expect(parseCmuxStatusLines("\n\ncrew_stage=closed\n\n")).toStrictEqual(
      new Map([["crew_stage", "closed"]]),
    );
  });

  it("ignores a line with no '='", () => {
    expect(parseCmuxStatusLines("not a status line")).toStrictEqual(new Map());
  });

  it("ignores a line starting with '='", () => {
    expect(parseCmuxStatusLines("=value")).toStrictEqual(new Map());
  });

  it("returns an empty map for empty output", () => {
    expect(parseCmuxStatusLines("")).toStrictEqual(new Map());
  });
});

describe(readCmuxStatus, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("lists status for the given workspace and parses it", async () => {
    runCommandMock.mockResolvedValue("crew_stage=peer_review\n");

    const result = await readCmuxStatus("workspace:1");

    expect(runCommandMock).toHaveBeenCalledWith("cmux", [
      "list-status",
      "--workspace",
      "workspace:1",
    ]);
    expect(result).toStrictEqual(new Map([["crew_stage", "peer_review"]]));
  });

  it("forwards the abort signal", async () => {
    runCommandMock.mockResolvedValue("");
    const { signal } = new AbortController();

    await readCmuxStatus("workspace:1", signal);

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      ["list-status", "--workspace", "workspace:1"],
      { signal },
    );
  });
});

describe(writeCmuxStatus, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("sets the key with its priority when value is non-empty", async () => {
    runCommandMock.mockResolvedValue("");

    await writeCmuxStatus("workspace:1", { key: "crew_stage", priority: -10, value: "my_review" });

    expect(runCommandMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "crew_stage",
      "my_review",
      "--priority",
      "-10",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("clears the key when value is empty", async () => {
    runCommandMock.mockResolvedValue("");

    await writeCmuxStatus("workspace:1", { key: "crew_stage", priority: -10, value: "" });

    expect(runCommandMock).toHaveBeenCalledWith("cmux", [
      "clear-status",
      "crew_stage",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("forwards the abort signal on set", async () => {
    runCommandMock.mockResolvedValue("");
    const { signal } = new AbortController();

    await writeCmuxStatus("workspace:1", { key: "crew_stage", priority: -10, value: "x" }, signal);

    expect(runCommandMock).toHaveBeenCalledWith("cmux", expect.any(Array), { signal });
  });

  it("forwards the abort signal on clear", async () => {
    runCommandMock.mockResolvedValue("");
    const { signal } = new AbortController();

    await writeCmuxStatus("workspace:1", { key: "crew_stage", priority: -10, value: "" }, signal);

    expect(runCommandMock).toHaveBeenCalledWith("cmux", expect.any(Array), { signal });
  });
});
