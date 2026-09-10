/** Stable, readable result type names for the controlled Node API bridges. */
export function nodeBuiltinResultType(id: string): string {
  return `${id.split(/[.-]/).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("")}Result`;
}
