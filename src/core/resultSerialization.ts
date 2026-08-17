import { createHash } from "node:crypto";
import type { CodeRef, DextResultBase, PatchResult } from "./types.js";

export function isDextResult(value: unknown): value is DextResultBase {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "kind" in value
    && typeof (value as { kind?: unknown }).kind === "string"
    && !["", "codeRef", "dirRef"].includes((value as { kind: string }).kind);
}

function resultContent(value: DextResultBase): string {
  return JSON.stringify(value, null, 2) ?? "{}";
}

function resultReference(value: DextResultBase, index: number): CodeRef {
  const content = resultContent(value);
  return {
    kind: "codeRef",
    uri: `dext-result://${value.kind}/${index}`,
    symbol: `${value.kind} result`,
    documentVersion: 0,
    contentHash: createHash("sha1").update(content).digest("hex"),
    content
  };
}

function patchReferences(value: PatchResult): CodeRef[] {
  if (!value.changes.length) return [resultReference(value, 0)];
  return value.changes.map((change, index) => ({
    kind: "codeRef" as const,
    uri: change.uri,
    symbol: `${value.title} change ${index + 1}`,
    documentVersion: 0,
    contentHash: createHash("sha1").update(change.after).digest("hex"),
    content: change.after
  }));
}

/** Convert a Result argument into the code-reference context expected by code APIs. */
export function resultToCodeRefs(value: DextResultBase): CodeRef[] {
  return value.kind === "patch"
    ? patchReferences(value as PatchResult)
    : [resultReference(value, 0)];
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
