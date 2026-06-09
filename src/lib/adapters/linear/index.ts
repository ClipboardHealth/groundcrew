import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createLinearTaskSource } from "./factory.ts";
import { linearAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof linearAdapterConfigSchema> = {
  kind: "linear",
  configSchema: linearAdapterConfigSchema,
  create: createLinearTaskSource,
};

export default definition;

export type { LinearSourceRef } from "./factory.ts";
