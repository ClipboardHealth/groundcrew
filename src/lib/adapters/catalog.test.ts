import { z } from "zod";

import type { AdapterDefinition, AdapterMeta } from "../adapterDefinition.ts";
import type { TaskSource } from "../taskSource.ts";

import { catalogFromRegistry, listTaskSources } from "./catalog.ts";

function adapterWith(kind: string, meta?: AdapterMeta): AdapterDefinition {
  return {
    kind,
    configSchema: z.object({ kind: z.literal(kind) }),
    create: () => ({}) as TaskSource,
    ...(meta === undefined ? {} : { meta }),
  };
}

describe(catalogFromRegistry, () => {
  it("projects each adapter's meta into a catalog row, defaulting requiresCredentials", () => {
    const registry = {
      linear: adapterWith("linear", {
        description: "Linear source",
        requiresCredentials: true,
        origin: "builtin",
      }),
      "todo-txt": adapterWith("todo-txt", {
        description: "todo.txt source",
        origin: "builtin",
      }),
    };

    const actual = catalogFromRegistry(registry);

    expect(actual).toStrictEqual([
      {
        name: "linear",
        description: "Linear source",
        origin: "builtin",
        requiresCredentials: true,
      },
      {
        name: "todo-txt",
        description: "todo.txt source",
        origin: "builtin",
        requiresCredentials: false,
      },
    ]);
  });

  it("excludes the generic shell template and adapters without meta", () => {
    const registry = {
      shell: adapterWith("shell", {
        description: "escape hatch",
        template: true,
        origin: "builtin",
      }),
      legacy: adapterWith("legacy"),
      jira: adapterWith("jira", {
        description: "JIRA",
        requiresCredentials: true,
        origin: "package",
      }),
    };

    const actual = catalogFromRegistry(registry);

    expect(actual.map((entry) => entry.name)).toStrictEqual(["jira"]);
  });
});

describe(listTaskSources, () => {
  it("lists the built-in code adapters and the bundled jira manifest, excluding shell", async () => {
    const catalog = await listTaskSources();
    const byName = new Map(catalog.map((entry) => [entry.name, entry]));

    expect(byName.has("linear")).toBe(true);
    expect(byName.has("todo-txt")).toBe(true);
    expect(byName.has("jira")).toBe(true);
    expect(byName.has("shell")).toBe(false);

    expect(byName.get("linear")?.requiresCredentials).toBe(true);
    expect(byName.get("jira")?.origin).toBe("package");
  });
});
