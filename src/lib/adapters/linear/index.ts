import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createLinearTicketSource } from "./factory.ts";
import { linearAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof linearAdapterConfigSchema> = {
  kind: "linear",
  configSchema: linearAdapterConfigSchema,
  create: createLinearTicketSource,
};

export default definition;
