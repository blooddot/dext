import { describe, expect, it } from "vitest";
import { pythonHoverCode } from "../src/vscodeHover.js";

describe("Python hover presentation", () => {
  it("presents call arguments as parameters and preserves indexed field annotations", () => {
    expect(pythonHoverCode("apply?: boolean = True", "parameter")).toBe("(parameter) apply: bool = True");
    expect(pythonHoverCode("confirmation.answers: dict[str, UiFieldAnswer]")).toBe("confirmation.answers: dict[str, UiFieldAnswer]");
    expect(pythonHoverCode('confirmation.answers["decision"].selected: list[string] | undefined'))
      .toBe('confirmation.answers["decision"].selected: list[str] | None');
  });
  it("renders result shapes as Python class declarations", () => {
    expect(pythonHoverCode('PrintResult { kind: "print"; text: string; label?: string }')).toBe(
      'class PrintResult:\n    kind: "print"\n    text: str\n    label: str | None'
    );
  });

  it("renders callable summaries as Python declarations", () => {
    expect(pythonHoverCode("agent(input: str) -> AgentResult")).toBe(
      "def agent(input: str) -> AgentResult:\n    ..."
    );
  });

  it("keeps nested shapes and optional members valid Python", () => {
    expect(pythonHoverCode('UiFormResult { kind: "ui"; type: "form"; answers?: { type: "select" | "input", selected?: list[string] } }')).toBe(
      'class UiFormResult:\n    kind: "ui"\n    type: "form"\n    answers: { type: "select" | "input", selected: list[str] | None } | None'
    );
  });

  it("namespaces a dotted declaration instead of writing an invalid identifier", () => {
    expect(pythonHoverCode('ui.Field { id: string; type: "select" | "input" }')).toBe(
      'class ui:\n    class Field:\n        id: str\n        type: "select" | "input"'
    );
    expect(pythonHoverCode("node.url.parse(url: string) -> NodeUrlParseResult")).toBe(
      "class node:\n    class url:\n        def parse(url: str) -> NodeUrlParseResult:\n            ..."
    );
  });

  it("renders optional parameters and defaults the Python way", () => {
    expect(pythonHoverCode('ui.select(label: string, options: list[string], multiple?: boolean = False, note?: string) -> UiSelectResult')).toBe(
      'class ui:\n    def select(label: str, options: list[str], multiple: bool = False, note: str | None = None) -> UiSelectResult:\n        ...'
    );
  });

  it("renders member annotations and nested member shapes as Python", () => {
    expect(pythonHoverCode("checked.stdout: string | undefined")).toBe("checked.stdout: str | None");
    expect(pythonHoverCode("form.answers: { type?: string, selected?: list[string] }")).toBe(
      "class AnswersShape:\n    type: str | None\n    selected: list[str] | None\n\nform.answers: AnswersShape"
    );
  });
});
