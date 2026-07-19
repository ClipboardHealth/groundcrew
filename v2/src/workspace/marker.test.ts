import * as fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addRepoToMarker, readMarker, writeMarker } from "./marker.js";
import { makeSandbox, type Sandbox } from "./testRepos.js";

const TASK_ID = "fixture:TASK-1";
const BRANCH = "crew/fixture-task-1";

describe("marker", () => {
  let sandbox: Sandbox;
  let workspaceDirectory: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    workspaceDirectory = path.join(sandbox.root, "workspace");
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("returns undefined when no marker exists", () => {
    expect(readMarker({ workspaceDirectory })).toBeUndefined();
  });

  it("writes and reads back a marker, creating .groundcrew", () => {
    writeMarker({
      workspaceDirectory,
      marker: { version: 1, taskId: TASK_ID, branch: BRANCH, repos: [] },
    });

    const actual = readMarker({ workspaceDirectory });

    expect(actual).toEqual({ version: 1, taskId: TASK_ID, branch: BRANCH, repos: [] });
  });

  it("appends repos idempotently and keeps them sorted", () => {
    writeMarker({
      workspaceDirectory,
      marker: { version: 1, taskId: TASK_ID, branch: BRANCH, repos: [] },
    });

    addRepoToMarker({ workspaceDirectory, taskId: TASK_ID, branch: BRANCH, repo: "beta" });
    addRepoToMarker({ workspaceDirectory, taskId: TASK_ID, branch: BRANCH, repo: "alpha" });
    const actual = addRepoToMarker({ workspaceDirectory, taskId: TASK_ID, branch: BRANCH, repo: "beta" });

    expect(actual.repos).toEqual(["alpha", "beta"]);
  });

  it("creates the marker when appending to an absent one", () => {
    addRepoToMarker({ workspaceDirectory, taskId: TASK_ID, branch: BRANCH, repo: "alpha" });

    expect(readMarker({ workspaceDirectory })).toEqual({
      version: 1,
      taskId: TASK_ID,
      branch: BRANCH,
      repos: ["alpha"],
    });
  });

  it("throws on invalid JSON", () => {
    const file = path.join(workspaceDirectory, ".groundcrew", "task.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");

    expect(() => readMarker({ workspaceDirectory })).toThrow(/valid JSON/u);
  });

  it("throws when the shape does not match the schema", () => {
    const file = path.join(workspaceDirectory, ".groundcrew", "task.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, taskId: TASK_ID }));

    expect(() => readMarker({ workspaceDirectory })).toThrow();
  });
});
