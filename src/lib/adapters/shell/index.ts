import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createShellTicketSource } from "./factory.ts";
import { shellAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof shellAdapterConfigSchema> = {
  kind: "shell",
  configSchema: shellAdapterConfigSchema,
  create: createShellTicketSource,
};

export default definition;
