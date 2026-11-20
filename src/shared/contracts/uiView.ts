import { z } from "zod";
import serializationLimits from "./dextSerializationLimits.json";

export const UI_VIEW_MAX_DEPTH = 32;
export const UI_VIEW_MAX_NODES = serializationLimits.uiRenderMaxNodes;
export const UI_VIEW_MAX_BYTES = serializationLimits.uiRenderMaxBytes;
export const UI_VIEW_STATUSES = ["pending", "in_progress", "completed"] as const;
export const UI_VIEW_TONES = ["normal", "muted", "info", "warning", "error"] as const;
export const UI_VIEW_ICONS = [
  "check", "terminal", "diff", "file-media", "circle-small-filled", "chevron-right",
  "checklist", "debug-pause", "circle-large-outline", "info", "warning", "error"
] as const;

const status = z.enum(UI_VIEW_STATUSES).optional();
const tone = z.enum(UI_VIEW_TONES).optional();
const text = z.string();
const leaves = [
  z.strictObject({ type: z.literal("TraceIcon"), icon: z.enum(UI_VIEW_ICONS) }),
  z.strictObject({ type: z.literal("TraceTitle"), text }),
  z.strictObject({ type: z.literal("TraceDescription"), text, tone }),
  z.strictObject({ type: z.literal("Text"), text, tone }),
  z.strictObject({ type: z.literal("Markdown"), source: text }),
  z.strictObject({ type: z.literal("Code"), text }),
  z.strictObject({ type: z.literal("CodeBlock"), code: text }),
  z.strictObject({ type: z.literal("Separator") }),
  z.strictObject({ type: z.literal("Badge"), text, status }),
  z.strictObject({ type: z.literal("Spinner"), label: z.string().regex(/\S/, "A Spinner requires a visible name.") }),
  z.strictObject({ type: z.literal("Alert"), text, tone })
] as const;

export type UiTraceLine = {
  type: "TraceLine";
  status?: typeof UI_VIEW_STATUSES[number] | undefined;
  tone?: typeof UI_VIEW_TONES[number] | undefined;
  children: UiTraceLineChild[];
};
type UiTrace = { type: "Trace"; ordered?: boolean | undefined; children: UiTraceLine[] };
export type UiTraceLineChild = UiTrace | z.infer<typeof leaves[number]>;
export type UiNode = UiTraceLineChild | UiTraceLine;

const traceChildren: z.ZodType<UiTraceLine[]> = z.lazy(() => z.array(traceLine));
const lineChildren: z.ZodType<UiTraceLineChild[]> = z.lazy(() => z.array(lineChild));
const trace = z.strictObject({ type: z.literal("Trace"), ordered: z.boolean().optional(), children: traceChildren });
const traceLine = z.strictObject({ type: z.literal("TraceLine"), status, tone, children: lineChildren });
const lineChild = z.discriminatedUnion("type", [trace, ...leaves]);
const node = z.discriminatedUnion("type", [trace, traceLine, ...leaves]);

export const UI_VIEW_NODE_TYPES = node.options.map((option) => option.shape.type.value);
export const UI_VIEW_LINE_CHILD_TYPES = lineChild.options.map((option) => option.shape.type.value);
const nodeFields = new Map<string, Set<string>>(node.options.map((option) => [
  option.shape.type.value, new Set(Object.keys(option.shape))
]));

type NodeIssue = { path: (string | number)[]; message: string };

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Bound the walk before Zod recurses and before serializing a malformed value. */
function inspectNodes(nodes: unknown): NodeIssue | undefined {
  let count = 0;
  let characters = 0;
  const issue = (path: NodeIssue["path"], message: string): NodeIssue => ({ path, message });
  const tooLarge = (path: NodeIssue["path"]): NodeIssue => issue(path, `UI tree exceeds ${UI_VIEW_MAX_BYTES} UTF-8 bytes.`);
  const visit = (items: unknown, depth: number, path: NodeIssue["path"]): NodeIssue | undefined => {
    if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype) return issue(path, "Expected an array of UI nodes.");
    if (count + items.length > UI_VIEW_MAX_NODES) return issue(path, `UI tree exceeds ${UI_VIEW_MAX_NODES} nodes.`);
    if (Reflect.ownKeys(items).length !== items.length + 1) return issue(path, "Expected a dense JSON array.");
    for (let index = 0; index < items.length; index++) {
      const nodePath = [...path, index];
      const item = Object.getOwnPropertyDescriptor(items, index)?.value as unknown;
      if (depth > UI_VIEW_MAX_DEPTH) return issue(nodePath, `UI tree exceeds ${UI_VIEW_MAX_DEPTH} levels.`);
      if (++count > UI_VIEW_MAX_NODES) return issue(nodePath, `UI tree exceeds ${UI_VIEW_MAX_NODES} nodes.`);
      if (!plainRecord(item)) return issue(nodePath, "Expected a plain JSON UI node.");
      const type: unknown = Object.getOwnPropertyDescriptor(item, "type")?.value;
      const allowed = typeof type === "string" ? nodeFields.get(type) : undefined;
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== "string") return issue(nodePath, "UI nodes accept only JSON keys.");
        if (allowed && !allowed.has(key)) return issue(nodePath, `Unrecognized key: ${JSON.stringify(key)}`);
        const fieldPath = [...nodePath, key];
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) return issue(fieldPath, "Expected a JSON value.");
        const value: unknown = descriptor.value;
        characters += key.length + (typeof value === "string" ? value.length : 0);
        if (characters > UI_VIEW_MAX_BYTES) return tooLarge(fieldPath);
        if (key === "children") {
          const nested = visit(value, depth + 1, fieldPath);
          if (nested) return nested;
        } else if (typeof value !== "string" && typeof value !== "boolean") {
          return issue(fieldPath, "Expected a string or boolean UI field.");
        }
      }
    }
    return undefined;
  };
  const invalid = visit(nodes, 1, []);
  if (invalid) return invalid;
  return new TextEncoder().encode(JSON.stringify(nodes)).length > UI_VIEW_MAX_BYTES ? tooLarge([]) : undefined;
}

const nodesSchema = z.unknown().superRefine((input, context) => {
  const issue = inspectNodes(input);
  if (issue) context.addIssue({ code: "custom", ...issue });
}).pipe(z.array(node).max(UI_VIEW_MAX_NODES));

export const uiRenderArgumentsSchema = z.unknown().superRefine((input, context) => {
  if (!plainRecord(input)) {
    context.addIssue({ code: "custom", message: "Expected a plain JSON options object." });
    return;
  }
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (key !== "nodes" || !descriptor.enumerable || !("value" in descriptor)) {
      context.addIssue({ code: "custom", message: `Invalid ui.render option: ${String(key)}` });
    }
  }
}).pipe(z.strictObject({ nodes: nodesSchema }));
export const uiViewResultSchema = z.strictObject({ kind: z.literal("view"), nodes: nodesSchema });
export type UiViewResult = z.infer<typeof uiViewResultSchema>;
