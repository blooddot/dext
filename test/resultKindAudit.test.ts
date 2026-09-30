import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dextResultSchema } from "../src/core/schemas.js";

/** Read the declared union instead of trusting a hand-written list here. */
function declaredBuiltinKinds(): string[] {
  const source = readFileSync(resolve("src", "core", "types.ts"), "utf8");
  const match = /export type BuiltinOutputKind =\r?\n([\s\S]*?);/.exec(source);
  if (!match) throw new Error("BuiltinOutputKind is not declared as a multi-line union.");
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]!).sort();
}

describe("Dext result kinds", () => {
  it("declares exactly the nine built-in kinds, with no escape hatch", () => {
    expect(declaredBuiltinKinds()).toEqual([
      "agent", "apply", "ask", "mcpRaw", "plan", "skill", "template", "terminal", "ui"
    ]);
    const source = readFileSync(resolve("src", "core", "types.ts"), "utf8");
    // A custom API is an ordinary module now, so `OutputKind` may only add the
    // managed `mcp.<server>.<tool>` namespace — never arbitrary strings.
    expect(source).toContain("export type OutputKind = BuiltinOutputKind | `mcp.${string}`;");
    expect(source).not.toContain("(string & {})");
  });

  it("accepts each built-in kind and refuses the removed ones", () => {
    const samples: Record<string, unknown> = {
      ask: { kind: "ask", text: "x" },
      plan: { kind: "plan", text: "x" },
      skill: { kind: "skill", text: "x" },
      template: { kind: "template", text: "x" },
      agent: { kind: "agent", text: "x" },
      apply: { kind: "apply", status: "unchanged", files: [], summary: "nothing to do" },
      terminal: { kind: "terminal", status: "succeeded", command: "ls", cwd: ".", exit_code: 0, stdout: "", stderr: "", duration_ms: 1 },
      ui: { kind: "ui", type: "confirm", confirmed: true },
      mcpRaw: { kind: "mcpRaw", server: "team", tool: "query" }
    };
    expect(Object.keys(samples).sort()).toEqual(declaredBuiltinKinds());
    for (const [kind, sample] of Object.entries(samples)) {
      expect(dextResultSchema.safeParse(sample).success, `${kind} must be a valid result`).toBe(true);
    }
    for (const removed of [
      { kind: "print", text: "x" },
      { kind: "node", value: 1 },
      { kind: "js", value: 1 },
      { kind: "patch", title: "t", changes: [] }
    ]) {
      expect(dextResultSchema.safeParse(removed).success, `${String(removed.kind)} must no longer be a result kind`).toBe(false);
    }
  });

  it("keeps ask, skill and template interchangeable", () => {
    const parsed = ["ask", "skill", "template"].map((kind) => {
      const result = dextResultSchema.safeParse({ kind, text: "hello" });
      expect(result.success, `${kind} takes {kind, text}`).toBe(true);
      return (result as { data: { kind: string; text: string } }).data;
    });
    // Same shape, same payload: the three kinds differ only in their name.
    expect(parsed.map(({ text }) => text)).toEqual(["hello", "hello", "hello"]);
    for (const kind of ["ask", "skill", "template"]) {
      expect(dextResultSchema.safeParse({ kind, text: 1 }).success, `${kind} requires text`).toBe(false);
      expect(dextResultSchema.safeParse({ kind }).success, `${kind} requires text`).toBe(false);
    }
  });

  it("keeps PatchResult as a nested field type instead of an output kind", () => {
    const accepted = dextResultSchema.safeParse({
      kind: "agent",
      text: "done",
      patch: { kind: "patch", title: "Edit", changes: [{ uri: "a.ts", before: "a", after: "b" }] }
    });
    expect(accepted.success).toBe(true);
    expect(dextResultSchema.safeParse({ kind: "agent", text: "done", patch: { title: "Edit", changes: [] } }).success).toBe(false);
  });
});
