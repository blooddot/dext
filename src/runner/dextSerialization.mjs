/**
 * The cross-process value rule for Dext API arguments, results and step payloads.
 *
 * The kernel and the extension host are separate processes that talk JSON, so a
 * value that cannot survive that trip is refused at the boundary with a message
 * that says what to write instead. `src/core/resultSerialization.ts` implements
 * the same rule on the TypeScript side and is tested against the same shapes.
 */

const MAX_DEPTH = 64;

function describe(path) {
  return path || "value";
}

function kindOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return "Buffer";
  if (ArrayBuffer.isView(value)) return "typed array";
  return typeof value;
}

export function toDextJson(value, label = "value", path = "") {
  const seen = new Set();

  function convert(current, currentPath, depth) {
    if (depth > MAX_DEPTH) {
      throw new Error(`${label} is nested more than ${MAX_DEPTH} levels deep at ${describe(currentPath)}.`);
    }
    switch (kindOf(current)) {
      case "null":
      case "boolean":
      case "string":
        return current;
      case "number":
        if (!Number.isFinite(current)) {
          throw new Error(`${label} contains ${String(current)} at ${describe(currentPath)}; use a finite number.`);
        }
        return current;
      case "undefined":
        throw new Error(`${label} is undefined at ${describe(currentPath)}; use null instead.`);
      case "function":
      case "symbol":
        throw new Error(
          `${label} contains a ${kindOf(current)} at ${describe(currentPath)}; a ${kindOf(current)} cannot cross the Dext boundary.`
        );
      case "bigint":
        throw new Error(`${label} contains a bigint at ${describe(currentPath)}; convert it with String() or Number().`);
      case "Date":
        return current.toISOString();
      case "Map":
        throw new Error(`${label} contains a Map at ${describe(currentPath)}; convert it to a plain object first.`);
      case "Set":
        throw new Error(`${label} contains a Set at ${describe(currentPath)}; convert it to an array first.`);
      case "Buffer":
        throw new Error(`${label} contains a Buffer at ${describe(currentPath)}; convert it to a string or a number array.`);
      case "typed array":
        throw new Error(`${label} contains a typed array at ${describe(currentPath)}; convert it to a number array.`);
      case "array": {
        if (seen.has(current)) throw new Error(`${label} contains a circular reference at ${describe(currentPath)}.`);
        seen.add(current);
        const items = current.map((item, index) => convert(item, `${currentPath}[${index}]`, depth + 1));
        seen.delete(current);
        return items;
      }
      case "object": {
        if (typeof current.toJSON === "function") return convert(current.toJSON(), currentPath, depth + 1);
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error(
            `${label} contains a ${current.constructor?.name ?? "class instance"} at ${describe(currentPath)}; ` +
            "return a plain object, or add a toJSON() method."
          );
        }
        if (seen.has(current)) throw new Error(`${label} contains a circular reference at ${describe(currentPath)}.`);
        seen.add(current);
        const result = {};
        for (const [key, item] of Object.entries(current)) {
          if (item === undefined) continue;
          result[key] = convert(item, currentPath ? `${currentPath}.${key}` : key, depth + 1);
        }
        seen.delete(current);
        return result;
      }
      default:
        throw new Error(`${label} contains a ${kindOf(current)} at ${describe(currentPath)}.`);
    }
  }

  return convert(value, path, 0);
}
