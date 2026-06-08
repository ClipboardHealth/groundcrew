import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createShellTaskSource } from "./factory.ts";
import { shellAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof shellAdapterConfigSchema> = {
  kind: "shell",
  configSchema: shellAdapterConfigSchema,
  create: createShellTaskSource,
};

export default definition;
