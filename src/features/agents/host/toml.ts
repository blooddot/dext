import { parse } from "smol-toml";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Parse TOML the same way `JSON.parse` reads JSON. Invalid input is absent. */
export function parseToml(source: string): Record<string, unknown> | undefined {
  try {
    return record(parse(source));
  } catch {
    return undefined;
  }
}

/** Read a nested string scalar from a parsed TOML table. */
export function tomlString(value: unknown, ...path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) current = record(current)?.[key];
  return typeof current === "string" && current ? current : undefined;
}
