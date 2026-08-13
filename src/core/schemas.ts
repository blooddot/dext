import { z } from "zod";

const contextKindSchema = z.enum(["selection", "activeFile", "file", "symbol"]);

function matchesDefaultType(
  type: "string" | "number" | "boolean" | "enum" | "context" | "patch",
  value: string | number | boolean
): boolean {
  if (type === "enum") {
    return typeof value === "string";
  }
  if (type === "context" || type === "patch") {
    return false;
  }
  return typeof value === type;
}

export const fieldDefinitionSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: z.enum(["string", "number", "boolean", "enum", "context", "patch"]),
    description: z.string().optional(),
    required: z.boolean().optional(),
    values: z.array(z.string()).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    multiple: z.boolean().optional()
  })
  .strict()
  .superRefine((field, context) => {
    if (field.type === "enum" && (!field.values || field.values.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Enum fields require at least one value.",
        path: ["values"]
      });
    }
    if (field.values && new Set(field.values).size !== field.values.length) {
      context.addIssue({
        code: "custom",
        message: "Enum values must be unique.",
        path: ["values"]
      });
    }
    if (field.default !== undefined && !matchesDefaultType(field.type, field.default)) {
      context.addIssue({
        code: "custom",
        message: `Default value does not match field type '${field.type}'.`,
        path: ["default"]
      });
    }
    if (
      field.type === "enum" &&
      typeof field.default === "string" &&
      !field.values?.includes(field.default)
    ) {
      context.addIssue({
        code: "custom",
        message: "Enum default must be one of the declared values.",
        path: ["default"]
      });
    }
    if (field.multiple && field.default !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Array fields cannot use a scalar default.",
        path: ["default"]
      });
    }
  });

export const callableDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    kind: z.enum(["command", "skill"]),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    input: z.array(fieldDefinitionSchema),
    output: z
      .object({
        kind: z.enum(["chat", "explain", "edit", "review", "apply", "terminal", "print", "text", "code", "plan", "patch"]),
        description: z.string().optional()
      })
      .strict(),
    context: z.array(contextKindSchema).optional(),
    executor: z
      .object({
        kind: z.literal("deterministic"),
        handler: z.string().regex(/^[a-z][a-zA-Z0-9]*$/)
      })
      .strict()
  })
  .strict()
  .superRefine((definition, context) => {
    const names = new Set<string>();
    definition.input.forEach((field, index) => {
      if (names.has(field.name)) {
        context.addIssue({
          code: "custom",
          message: `Input field '${field.name}' is declared more than once.`,
          path: ["input", index, "name"]
        });
      }
      names.add(field.name);
    });
    if (
      definition.input.some((field) => field.type === "context") &&
      (!definition.context || definition.context.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Methods with context inputs must declare allowed context references.",
        path: ["context"]
      });
    }
    if (
      definition.context &&
      new Set(definition.context).size !== definition.context.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Allowed context references must be unique.",
        path: ["context"]
      });
    }
  });

export const methodsFileSchema = z
  .object({
    version: z.literal(1),
    methods: z.array(callableDefinitionSchema)
  })
  .strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    file.methods.forEach((method, index) => {
      if (ids.has(method.id)) {
        context.addIssue({
          code: "custom",
          message: `Method '${method.id}' is declared more than once.`,
          path: ["methods", index, "id"]
        });
      }
      ids.add(method.id);
    });
  });

export const textResultSchema = z.object({ kind: z.literal("text"), text: z.string() });
export const codeResultSchema = z.object({
  kind: z.literal("code"),
  code: z.string(),
  language: z.string(),
  title: z.string().optional()
});
export const reviewResultSchema = z.object({
  kind: z.literal("review"),
  status: z.enum(["pass", "warning", "fail"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      message: z.string(),
      uri: z.string().optional(),
      line: z.number().int().nonnegative().optional()
    })
  )
});
export const chatResultSchema = z.object({ kind: z.literal("chat"), text: z.string() });
export const explainResultSchema = z.object({
  kind: z.literal("explain"),
  text: z.string(),
  files: z.array(z.unknown())
});
export const editResultSchema = z.object({
  kind: z.literal("edit"),
  summary: z.string(),
  patch: z.lazy(() => patchResultSchema),
  files: z.array(z.unknown())
});
export const applyResultSchema = z.object({
  kind: z.literal("apply"),
  status: z.enum(["applied", "unchanged", "conflict"]),
  files: z.array(z.unknown()),
  summary: z.string()
});
export const terminalResultSchema = z.object({
  kind: z.literal("terminal"),
  status: z.enum(["succeeded", "failed", "timed_out"]),
  command: z.string(),
  cwd: z.string(),
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number().nonnegative()
});
export const printResultSchema = z.object({
  kind: z.literal("print"),
  text: z.string(),
  label: z.string().optional()
}).strict();
export const planResultSchema = z.object({
  kind: z.literal("plan"),
  title: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string().optional(),
      status: z.enum(["pending", "ready"])
    })
  )
});
export const patchResultSchema = z.object({
  kind: z.literal("patch"),
  title: z.string(),
  changes: z.array(
    z.object({ uri: z.string(), before: z.string(), after: z.string() })
  )
});

export const dextResultSchema = z.discriminatedUnion("kind", [
  chatResultSchema,
  explainResultSchema,
  editResultSchema,
  textResultSchema,
  codeResultSchema,
  reviewResultSchema,
  planResultSchema,
  patchResultSchema,
  applyResultSchema,
  terminalResultSchema,
  printResultSchema
]);
