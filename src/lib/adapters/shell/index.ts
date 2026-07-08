import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createShellTaskSource } from "./factory.ts";
import { shellAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof shellAdapterConfigSchema> = {
  kind: "shell",
  configSchema: shellAdapterConfigSchema,
  create: createShellTaskSource,
  meta: {
    description: "Bring-your-own task source wired through shell command templates.",
    // The generic escape hatch, not an installable source: excluded from the catalog.
    template: true,
    origin: "builtin",
  },
};

export default definition;
