import { describe, expect, it } from "vitest";
import { builtinResultFieldType, builtinTypeDefinition, builtinTypeDocument, builtinTypeSignature } from "../src/core/builtinTypeDefinitions.js";

describe("built-in Dext type definitions", () => {
  it("renders result shapes and stable navigation ranges from one catalog", () => {
    const definition = builtinTypeDefinition("AgentResult")!;
    expect(builtinTypeSignature(definition)).toContain("patch?: PatchResult");
    expect(builtinResultFieldType("agent", "summary")).toBe("string | undefined");
    expect(builtinResultFieldType("print", "label")).toBe("string | undefined");
    const document = builtinTypeDocument();
    const range = document.ranges.get("PrintResult")!;
    expect(document.text.slice(range.nameFrom, range.nameTo)).toBe("PrintResult");
    expect(document.text).toContain("class AgentResult:");
    const nodeRange = document.ranges.get("NodeUrlParseResult")!;
    expect(document.text.slice(nodeRange.from, nodeRange.to)).toContain("pathname: str");
    const formRange = document.ranges.get("UiFormResult")!;
    expect(document.text.slice(formRange.from, formRange.to)).toContain("answers:");
    const fieldRange = document.ranges.get("ui.Field")!;
    expect(document.text.slice(fieldRange.from, fieldRange.to)).toContain("options:");
    expect(document.text).toContain("class ui:");
    expect(builtinTypeDefinition("agent.ModelOptions")?.fields.map((field) => field.name)).toContain("model");
  });
});
