import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CmuxPresenter, type Presenter } from "./index.js";

describe("cmux presenter conformance", () => {
  it("conforms through the fixture executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-presenter-"));
    const statePath = join(root, "state.json");
    const callsPath = join(root, "calls.jsonl");
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    await Promise.all([writeFile(statePath, '{"workspaces":[]}'), writeFile(callsPath, "")]);
    const presenter = new CmuxPresenter({
      environment: {
        ...process.env,
        FAKE_CMUX_CALLS: callsPath,
        FAKE_CMUX_STATE: statePath,
        PATH: `${fakeBin}:${process.env["PATH"]}`,
      },
    });

    await exercisePresenter({ name: "crew-conformance-fixture", presenter });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("new-workspace");
    expect(calls).toContain("set-progress");
    expect(calls).toContain("close-workspace");
  });

  it("reports malformed cmux output as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-presenter-invalid-json-"));
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    const presenter = new CmuxPresenter({
      environment: {
        ...process.env,
        FAKE_CMUX_CALLS: join(root, "calls.jsonl"),
        FAKE_CMUX_INVALID_JSON: "1",
        FAKE_CMUX_STATE: join(root, "state.json"),
        PATH: `${fakeBin}:${process.env["PATH"]}`,
      },
    });

    await expect(presenter.probe()).resolves.toEqual({ available: false, workspaces: [] });
  });

  it.runIf(process.env["GROUNDCREW_LIVE_CMUX"] === "1")("conforms through live cmux", async () => {
    await exercisePresenter({
      name: `crew-conformance-live-${process.pid}`,
      presenter: new CmuxPresenter({ environment: process.env }),
    });
  });
});

async function exercisePresenter(input: { readonly name: string; readonly presenter: Presenter }) {
  await input.presenter.open({
    command: ["/usr/bin/true"],
    environment: { GROUNDCREW_TASK_ID: `conformance:${input.name}` },
    name: input.name,
    workingDirectory: process.cwd(),
  });
  try {
    const opened = await input.presenter.probe();
    expect(opened.available).toBe(true);
    expect(opened.workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: input.name })]),
    );
    expect(await input.presenter.accessHint({ name: input.name })).toContain("workspace");
    await input.presenter.setStatus?.({ name: input.name, text: "running" });
  } finally {
    await input.presenter.close({ name: input.name });
  }
  const closed = await input.presenter.probe();
  expect(closed.workspaces).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: input.name })]),
  );
}
