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

const MAX_BOUNDARY_DEPTH = 64;

/**
 * The value rule for everything that crosses the kernel/extension-host boundary.
 *
 * The two processes talk JSON, so a value that cannot survive that trip is
 * refused where it is produced rather than silently degraded at `process.send`.
 * `src/runner/dextSerialization.mjs` implements the same rule for the kernel side
 * and is tested against the same shapes.
 */
export function toBoundaryJson(value: unknown, label = "value"): unknown {
  const seen = new Set<object>();

  const convert = (current: unknown, path: string, depth: number): unknown => {
    const at = path || "value";
    if (depth > MAX_BOUNDARY_DEPTH) {
      throw new Error(`${label} is nested more than ${MAX_BOUNDARY_DEPTH} levels deep at ${at}.`);
    }
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${label} contains ${String(current)} at ${at}; use a finite number.`);
      return current;
    }
    if (current === undefined) throw new Error(`${label} is undefined at ${at}; use null instead.`);
    if (typeof current === "function" || typeof current === "symbol") {
      throw new Error(`${label} contains a ${typeof current} at ${at}; a ${typeof current} cannot cross the Dext boundary.`);
    }
    if (typeof current === "bigint") {
      throw new Error(`${label} contains a bigint at ${at}; convert it with String() or Number().`);
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Map) throw new Error(`${label} contains a Map at ${at}; convert it to a plain object first.`);
    if (current instanceof Set) throw new Error(`${label} contains a Set at ${at}; convert it to an array first.`);
    if (Buffer.isBuffer(current)) {
      throw new Error(`${label} contains a Buffer at ${at}; convert it to a string or a number array.`);
    }
    if (ArrayBuffer.isView(current)) {
      throw new Error(`${label} contains a typed array at ${at}; convert it to a number array.`);
    }
    if (typeof current !== "object") throw new Error(`${label} contains a ${typeof current} at ${at}.`);
    const object = current as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof object.toJSON === "function") return convert(object.toJSON(), at, depth + 1);
    if (Array.isArray(object)) {
      if (seen.has(object)) throw new Error(`${label} contains a circular reference at ${at}.`);
      seen.add(object);
      try {
        return object.map((item, index) => convert(item, `${path}[${index}]`, depth + 1));
      } finally {
        seen.delete(object);
      }
    }
    const prototype = Object.getPrototypeOf(object) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (object as { constructor?: { name?: string } }).constructor?.name ?? "class instance";
      throw new Error(`${label} contains a ${name} at ${at}; return a plain object, or add a toJSON() method.`);
    }
    if (seen.has(object)) throw new Error(`${label} contains a circular reference at ${at}.`);
    seen.add(object);
    try {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(object)) {
        if (item === undefined) continue;
        result[key] = convert(item, path ? `${path}.${key}` : key, depth + 1);
      }
      return result;
    } finally {
      seen.delete(object);
    }
  };

  return convert(value, "", 0);
}
