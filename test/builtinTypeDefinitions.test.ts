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

  it("renders every member as a Python annotation", () => {
    const document = builtinTypeDocument();
    expect(document.text).not.toContain("?:");
    const formRange = document.ranges.get("UiFormResult")!;
    const form = document.text.slice(formRange.from, formRange.to);
    // The runtime always sets the discriminators and the interaction payload.
    expect(form).toContain('type: "form"');
    expect(form).not.toContain('type: "form" | None');
    expect(form).toContain('status: "submitted" | "cancelled"');
    expect(form).toContain('answers: dict[str, UiFieldAnswer]');
    const answerRange = document.ranges.get("UiFieldAnswer")!;
    const answer = document.text.slice(answerRange.from, answerRange.to);
    expect(answer).toContain('type: "select" | "radio" | "checkbox" | "input"');
    expect(answer).toContain('selected: list[str] | None');
    const selectRange = document.ranges.get("UiSelectResult")!;
    const select = document.text.slice(selectRange.from, selectRange.to);
    expect(select).toContain('type: "select"');
    expect(select).not.toContain("| None");
  });
});
