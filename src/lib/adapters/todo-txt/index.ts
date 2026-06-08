import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createTodoTxtTaskSource } from "./source.ts";
import { todoTxtAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof todoTxtAdapterConfigSchema> = {
  kind: "todo-txt",
  configSchema: todoTxtAdapterConfigSchema,
  create: createTodoTxtTaskSource,
};

export default definition;
