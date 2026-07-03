import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createLinearTaskSource } from "./factory.ts";
import { linearAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof linearAdapterConfigSchema> = {
  kind: "linear",
  configSchema: linearAdapterConfigSchema,
  create: createLinearTaskSource,
  meta: {
    description:
      "Pick up Linear issues assigned to your API key's viewer that carry an agent-* label.",
    requiresCredentials: true,
    origin: "builtin",
  },
};

export default definition;

export type { LinearSourceRef } from "./factory.ts";
