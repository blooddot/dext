import type { DextResultBase } from "./types.js";

export function isDextResult(value: unknown): value is DextResultBase {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "kind" in value
    && typeof (value as { kind?: unknown }).kind === "string"
    && !["", "codeRef", "dirRef"].includes((value as { kind: string }).kind);
}

/** Stable, explicit wire representation used when a Result is sent to an Agent CLI. */
export function serializeResultForAgent<T extends DextResultBase>(value: T): Record<string, unknown> {
  return {
    kind: "dext-result",
    version: 1,
    result_kind: value.kind,
    value
  };
}
