import { execa } from "execa";
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

  it("stays available when a listed workspace disappears before its environment is read", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-presenter-disappearing-workspace-"));
    const statePath = join(root, "state.json");
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    await writeFile(
      statePath,
      JSON.stringify({
        workspaces: [
          {
            environment: { GROUNDCREW_PRESENTATION_ID: "presentation-1" },
            id: "workspace-1",
            title: "workspace",
          },
        ],
      }),
    );
    const presenter = new CmuxPresenter({
      environment: {
        ...process.env,
        FAKE_CMUX_CALLS: join(root, "calls.jsonl"),
        FAKE_CMUX_DELETE_BEFORE_ENV_READ: "workspace-1",
        FAKE_CMUX_STATE: statePath,
        PATH: `${fakeBin}:${process.env["PATH"]}`,
      },
    });

    await expect(presenter.probe()).resolves.toEqual({ available: true, workspaces: [] });
  });

  it("reports an already-missing workspace through the fake cmux process", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-presenter-missing-workspace-"));
    const fakeCmux = join(process.cwd(), "e2e", "fixtures", "fake-bin", "cmux");
    const statePath = join(root, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ workspaces: [{ environment: {}, id: "workspace-2", title: "other" }] }),
    );

    const result = await execa(fakeCmux, ["workspace", "env", "workspace-1"], {
      env: {
        ...process.env,
        FAKE_CMUX_CALLS: join(root, "calls.jsonl"),
        FAKE_CMUX_STATE: statePath,
      },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("workspace not found: workspace-1");
  });

  it.runIf(process.env["GROUNDCREW_LIVE_CMUX"] === "1")("conforms through live cmux", async () => {
    await exercisePresenter({
      name: `crew-conformance-live-${process.pid}`,
      presenter: new CmuxPresenter({ environment: process.env }),
    });
  });
});

async function exercisePresenter(input: { readonly name: string; readonly presenter: Presenter }) {
  const presentation = await input.presenter.open({
    command: ["/usr/bin/true"],
    displayName: input.name,
    environment: { GROUNDCREW_TASK_ID: `conformance:${input.name}` },
    presentationId: input.name,
    workingDirectory: process.cwd(),
  });
  try {
    const opened = await input.presenter.probe();
    expect(opened.available).toBe(true);
    expect(opened.workspaces).toEqual(expect.arrayContaining([presentation]));
    expect(await input.presenter.accessHint(presentation)).toContain("workspace");
    await input.presenter.setStatus?.({ ...presentation, text: "running" });
  } finally {
    await input.presenter.close(presentation);
  }
  const closed = await input.presenter.probe();
  expect(closed.workspaces).not.toEqual(expect.arrayContaining([presentation]));
}
