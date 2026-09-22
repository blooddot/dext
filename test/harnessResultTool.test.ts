import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import { HARNESS_RESULT_TOOL, harnessResultInstruction, harnessResultTool, parseHarnessResultRequest } from "../src/core/harnessResultTool.js";

describe("Harness result tool", () => {
  it("publishes one named tool whose arguments are the call's own contract", () => {
    const tool = harnessResultTool({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { kind: { const: "ask" }, text: { type: "string" } },
      required: ["kind", "text"]
    });
    expect(tool?.name).toBe(HARNESS_RESULT_TOOL);
    // The draft keyword describes the schema document, not the arguments, and
    // provider function-calling schemas do not carry it.
    expect(tool?.parameters).toEqual({ type: "object", properties: { kind: { const: "ask" }, text: { type: "string" } }, required: ["kind", "text"] });
    expect(tool?.description).toContain("complete result object itself");
  });

  it("takes every object-rooted builtin contract and refuses the union ones", () => {
    const adapter = new AxAdapter();
    for (const method of BUILTIN_METHODS) {
      const contract = adapter.compile({ ...method, source: "builtin" } as never);
      const tool = harnessResultTool(contract.outputJsonSchema);
      if (method.id.startsWith("ui.")) {
        // A `ui` contract is a root `oneOf` (value or cancellation); a
        // function-calling tool needs one object, so it keeps the prompt form.
        expect(tool, method.id).toBeUndefined();
      } else {
        expect(tool?.parameters, method.id).toMatchObject({ type: "object" });
      }
    }
  });

  it("names the tool as the answer channel and keeps the final message as its fallback", () => {
    const instruction = harnessResultInstruction();
    expect(instruction).toContain(`\`${HARNESS_RESULT_TOOL}\``);
    expect(instruction).toContain("result object itself as its arguments");
    expect(instruction).toContain("final message");
  });

  it("reads a submission frame and rejects every other shape on the channel", () => {
    expect(parseHarnessResultRequest({ id: "s1", kind: "submit", args: { kind: "ask", text: "x" } }))
      .toEqual({ id: "s1", args: { kind: "ask", text: "x" } });
    // A submission may be `null` or a scalar: the contract decides, not this parser.
    expect(parseHarnessResultRequest({ id: "s2", kind: "submit", args: null })).toEqual({ id: "s2", args: null });
    // Anything else is a question frame, a reply, or malformed.
    expect(parseHarnessResultRequest({ id: "q", questions: [] })).toBeUndefined();
    expect(parseHarnessResultRequest({ id: "s", kind: "submit" })).toBeUndefined();
    expect(parseHarnessResultRequest({ kind: "submit", args: {} })).toBeUndefined();
    expect(parseHarnessResultRequest({ id: "", kind: "submit", args: {} })).toBeUndefined();
    expect(parseHarnessResultRequest({ id: "s", kind: "tool", args: {} })).toBeUndefined();
    expect(parseHarnessResultRequest("submit")).toBeUndefined();
    expect(parseHarnessResultRequest([])).toBeUndefined();
    expect(parseHarnessResultRequest(null)).toBeUndefined();
  });
});
