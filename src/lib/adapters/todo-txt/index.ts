import type { AdapterDefinition } from "../../adapterDefinition.ts";

import { createTodoTxtTaskSource } from "./source.ts";
import { todoTxtAdapterConfigSchema } from "./schema.ts";

const definition: AdapterDefinition<typeof todoTxtAdapterConfigSchema> = {
  kind: "todo-txt",
  configSchema: todoTxtAdapterConfigSchema,
  create: createTodoTxtTaskSource,
  meta: {
    description: "Track tasks from a local todo.txt file; no credentials required.",
    origin: "builtin",
  },
};

export default definition;
