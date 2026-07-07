import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DiscoveredManifest } from "./adapters/shell/discovery.ts";
import { sourceSupportsMarkDone, taskSupportsCompletionCommand } from "./sourceCapabilities.ts";

describe(sourceSupportsMarkDone, () => {
  it("continues past non-matching sources before returning the markDone capability", () => {
    const rawSources = [
      { kind: "linear" },
      {
        kind: "todo-txt",
        name: "todo",
        todoPath: "todo.txt",
        tasksDir: ".tasks",
        idPrefix: "GC",
        timezone: "UTC",
      },
    ];

    const actual = sourceSupportsMarkDone({ rawSources, sourceName: "todo" });

    expect(actual).toBe(true);
  });

  it("uses discovered manifest commands for manifest-backed source kinds", () => {
    const home = mkdtempSync(path.join(tmpdir(), "source-capabilities-xdg-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    try {
      const rawSources = [{ kind: "jira" }];

      const actual = sourceSupportsMarkDone({ rawSources, sourceName: "jira" });

      expect(actual).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("caches discovered manifest capabilities across repeated lookups", async () => {
    vi.resetModules();
    const mockDiscoverTaskSourceManifests = vi.fn<() => DiscoveredManifest[]>(() => [
      {
        manifest: {
          name: "jira",
          kind: "shell",
          description: "jira",
          installDir: "~/.config/groundcrew",
          files: [],
          commands: { listTasks: "jira list", markDone: "jira done" },
        },
        manifestDir: "/tmp/jira",
        origin: "package",
      },
    ]);
    vi.doMock("./adapters/shell/discovery.ts", () => ({
      discoverTaskSourceManifests: mockDiscoverTaskSourceManifests,
    }));
    try {
      const { sourceSupportsMarkDone: sourceSupportsMarkDoneWithMock } =
        await import("./sourceCapabilities.ts");
      const rawSources = [{ kind: "jira" }];

      expect(sourceSupportsMarkDoneWithMock({ rawSources, sourceName: "jira" })).toBe(true);
      expect(sourceSupportsMarkDoneWithMock({ rawSources, sourceName: "jira" })).toBe(true);

      expect(mockDiscoverTaskSourceManifests).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("./adapters/shell/discovery.ts");
      vi.resetModules();
    }
  });
});

describe(taskSupportsCompletionCommand, () => {
  it("returns false for unprefixed task ids when the source is ambiguous", () => {
    const rawSources = [
      { kind: "linear" },
      {
        kind: "todo-txt",
        name: "todo",
        todoPath: "todo.txt",
        tasksDir: ".tasks",
        idPrefix: "GC",
        timezone: "UTC",
      },
    ];

    expect(taskSupportsCompletionCommand({ rawSources: [], taskId: "team-1" })).toBe(false);
    expect(taskSupportsCompletionCommand({ rawSources, taskId: "team-1" })).toBe(false);
  });
});
