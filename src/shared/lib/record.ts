/** One shape test for every untrusted JSON object Dext reads: manifests, MCP
 * results, workflow arguments. `null` and arrays are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
