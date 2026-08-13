import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { compileWorkflow } from "../src/core/workflow.js";

function compile(source: string) {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  return compileWorkflow(source, registry);
}

describe("Dext Python workflow compiler", () => {
  it("compiles assignments, references, result fields, and if branches", () => {
    const result = compile(`analysis = chat(
    message="""Explain this code""",
    context=[ref.selection],
)
edit = code.edit(target=[ref.selection], instruction=analysis.text)
review = code.review(target=edit.files, instruction=edit.summary)
if review.status == "pass":
    code.apply(result=edit)
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.statements).toHaveLength(4);
  });

  it("accepts a single reference for a multi-target API", () => {
    expect(compile('edit = code.edit(target=ref.selection, instruction="format")').diagnostics)
      .toEqual([]);
  });

  it("accepts adjacent chat and file explanation statements without diagnostics", () => {
    const source = `chat(message="输入测试")
result = code.explain(target=[ref.file("pathx.py#L65,1-L78,1")])`;
    expect(compile(source).diagnostics).toEqual([]);
  });

  it("accepts patch results as code review and explanation targets", () => {
    const result = compile(`edit_result = code.edit(target=ref.selection, instruction="format")
review_result = code.review(target=edit_result.patch)
explanation = code.explain(target=edit_result.patch)
`);
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts every Dext result through the shared Result input type", () => {
    const result = compile(`chat_result = chat(message="hello")
review_result = code.review(target=chat_result)
explain_result = code.explain(target=review_result)
applied = code.apply(result=review_result)
`);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports syntax, type, and unknown API diagnostics", () => {
    expect(compile('chat(message="unterminated)').diagnostics.length).toBeGreaterThan(0);
    expect(compile("chat(message=1)").diagnostics.map((item) => item.message).join("\n"))
      .toContain("expects string");
    expect(compile("unknown.call(value=1)").diagnostics.map((item) => item.message).join("\n"))
      .toContain("Unknown Dext API");
  });

  it("checks comparison types and string unions", () => {
    const wrongType = compile('review = code.review(target=ref.selection)\nif review.status == 1:\n    chat(message="x")');
    expect(wrongType.diagnostics.map((item) => item.message)).toContain(
      "Cannot compare string with number."
    );

    const wrongStatus = compile('review = code.review(target=ref.selection)\nif review.status == "approved":\n    chat(message="x")');
    expect(wrongStatus.diagnostics.map((item) => item.message).join("\n"))
      .toContain('Expected one of "pass", "warning", "fail".');
  });

  it.each([
    ["import os", "Import is not allowed"],
    ["for value in values:\n    chat(message=value)", "For is not allowed"],
    ["def run():\n    pass", "FunctionDefinition is not allowed"],
    ["value = open(\"a\")", "Unknown Dext API 'open'"],
    ["value = chat(message=\"a\")\nvalue = chat(message=\"b\")", "cannot be reassigned"]
  ])("rejects unsupported Python: %s", (source, message) => {
    expect(compile(source).diagnostics.map((item) => item.message).join("\n")).toContain(message);
  });
});
