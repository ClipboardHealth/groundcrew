import { z } from "zod";

export const todoTxtAdapterConfigSchema = z.object({
  kind: z.literal("todo-txt"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
    .default("todo"),
  todoPath: z.string().default("todo.txt"),
  tasksDir: z.string().default(".tasks"),
  defaultRepository: z.string().optional(),
  idPrefix: z.string().default("GC"),
  timezone: z.string().default("UTC"),
});

export type TodoTxtAdapterConfig = z.infer<typeof todoTxtAdapterConfigSchema>;
