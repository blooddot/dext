/**
 * The cross-process value rule for Dext API arguments, results and step payloads.
 *
 * The kernel and the extension host are separate processes that talk JSON, so a
 * value that cannot survive that trip is refused at the boundary with a message
 * that says what to write instead. `src/shared/protocol/resultSerialization.ts` implements
 * the same rule on the TypeScript side and is tested against the same shapes.
 */

import limits from "../shared/contracts/dextSerializationLimits.json" with { type: "json" };

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

export function toDextJson(value, label = "value", path = "", { plain = false } = {}) {
  const seen = new Set();
  // A UI level uses a node object and its children array. The shared limit
  // covers the response envelope and leaves room for the host's depth diagnostic.
  const maxDepth = plain ? limits.uiRenderDepth : MAX_DEPTH;
  let nodeCount = 0;
  // The host measures the nodes array. The kernel also copies its argument envelope.
  let bytesLeft = limits.uiRenderMaxBytes + '{"nodes":}'.length;
  const tooLarge = () => new Error(`UI tree exceeds ${limits.uiRenderMaxBytes} UTF-8 bytes.`);
  const chargeBytes = (bytes) => {
    bytesLeft -= bytes;
    if (bytesLeft < 0) throw tooLarge();
  };
  const chargeString = (string) => {
    // Bound the temporary encoded string before measuring escapes and UTF-8 bytes.
    if (string.length + 2 > bytesLeft) throw tooLarge();
    chargeBytes(Buffer.byteLength(JSON.stringify(string)));
  };
  const nonJson = (at) => new Error(`${label} requires plain JSON at ${describe(at)}.`);
  const ownValue = (object, key, at) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw nonJson(at);
    return descriptor.value;
  };

  function convert(current, currentPath, depth) {
    if (depth > maxDepth) {
      throw new Error(`${label} is nested more than ${maxDepth} levels deep at ${describe(currentPath)}.`);
    }
    switch (kindOf(current)) {
      case "null":
      case "boolean":
        if (plain) chargeBytes(String(current).length);
        return current;
      case "string":
        if (plain) chargeString(current);
        return current;
      case "number":
        if (!Number.isFinite(current)) {
          throw new Error(`${label} contains ${String(current)} at ${describe(currentPath)}; use a finite number.`);
        }
        if (plain) chargeBytes(String(current).length);
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
        if (plain) throw nonJson(currentPath);
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
        if (plain) {
          // Every array in a valid ui.render argument is a list of UI nodes.
          nodeCount += current.length;
          if (nodeCount > limits.uiRenderMaxNodes) throw new Error(`UI tree exceeds ${limits.uiRenderMaxNodes} nodes.`);
          chargeBytes(2 + Math.max(0, current.length - 1));
          if (Object.getPrototypeOf(current) !== Array.prototype || Reflect.ownKeys(current).length !== current.length + 1) {
            throw nonJson(currentPath);
          }
        }
        seen.add(current);
        const items = plain ? Array.from({ length: current.length }, (_, index) => {
          const at = `${currentPath}[${index}]`;
          return convert(ownValue(current, index, at), at, depth + 1);
        }) : current.map((item, index) => convert(item, `${currentPath}[${index}]`, depth + 1));
        seen.delete(current);
        return items;
      }
      case "object": {
        if (!plain && typeof current.toJSON === "function") return convert(current.toJSON(), currentPath, depth + 1);
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error(
            `${label} contains a ${current.constructor?.name ?? "class instance"} at ${describe(currentPath)}; ` +
            "return a plain object, or add a toJSON() method."
          );
        }
        if (seen.has(current)) throw new Error(`${label} contains a circular reference at ${describe(currentPath)}.`);
        seen.add(current);
        const result = plain ? Object.create(null) : {};
        if (plain) {
          const keys = Reflect.ownKeys(current);
          chargeBytes(2 + Math.max(0, keys.length - 1));
          for (const key of keys) {
            if (typeof key !== "string") throw nonJson(currentPath);
            chargeString(key);
            chargeBytes(1);
            const at = currentPath ? `${currentPath}.${key}` : key;
            result[key] = convert(ownValue(current, key, at), at, depth + 1);
          }
        } else {
          for (const [key, item] of Object.entries(current)) {
            if (item === undefined) continue;
            result[key] = convert(item, currentPath ? `${currentPath}.${key}` : key, depth + 1);
          }
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
