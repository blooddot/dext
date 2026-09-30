import { describe, expect, it } from "vitest";
import { builtinApiDefinition, builtinApiDocument, builtinApiNamespace, builtinApiReferenceTarget } from "../src/core/builtinApiDefinitions.js";

describe("built-in API definitions", () => {
  it("renders every registered API into a navigable TypeScript document", () => {
    expect(builtinApiDefinition("ui.select")?.title).toBe("select");
    expect(builtinApiNamespace("ui")).toBe(true);
    expect(builtinApiNamespace("ui.select")).toBe(false);
    const document = builtinApiDocument();
    expect(document.text).toContain("// API: agent");
    expect(document.text).toContain("export function agent(");
    expect(document.text).toContain("): Promise<AgentResult>;");
    expect(document.text).toContain("apply?: boolean");
    expect(document.text).toContain("// Namespace: ui");
    expect(document.text).toContain("export const ui = {");

    const range = document.ranges.get("ui.select")!;
    expect(document.text.slice(range.nameFrom, range.nameTo)).toBe("select");
    expect(document.text.slice(range.from, range.to)).toContain("options:");
    expect(builtinApiReferenceTarget(document.text, document.text.indexOf("// API: ui.select") + 9)).toMatchObject({ id: "ui.select" });
    expect(builtinApiReferenceTarget(document.text, document.text.indexOf("export const ui") + "export const ".length + 1)).toMatchObject({ id: "ui" });
    expect(builtinApiReferenceTarget(document.text, document.text.indexOf("select: (options") + 2)).toMatchObject({ id: "ui.select" });
  });

  it("annotates generated signatures with TypeScript types", () => {
    const document = builtinApiDocument();
    const range = document.ranges.get("ui.select")!;
    const signature = document.text.slice(range.from, range.to);
    expect(signature).toContain("options: { label: string; options: string[]");
    expect(signature).toContain('presentation?: "inline" | "dialog"');
    expect(signature).toContain('//   type: "select"');
    expect(signature).not.toContain("list[");
  });

  it("exposes template rendering under its own id and result type", () => {
    expect(builtinApiDefinition("template")).toMatchObject({ output: { kind: "template" } });
    const document = builtinApiDocument();
    const range = document.ranges.get("template")!;
    const signature = document.text.slice(range.from, range.to);
    expect(signature).toContain("export function template(");
    expect(signature).toContain("source: string");
    expect(signature).toContain("Promise<TemplateResult>;");
  });
});
