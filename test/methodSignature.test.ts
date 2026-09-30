import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { CONVERSATION_METHODS, formatFieldType, formatMethodParameter, methodResultType } from "../src/core/methodSignature.js";
import type { CallableDefinition, FieldDefinition } from "../src/core/types.js";

describe("API parameter contracts", () => {
  it("renders a built-in parameter with its optionality and default", () => {
    const agent = BUILTIN_METHODS.find((method) => method.id === "agent");
    expect(agent).toBeDefined();
    const apply = agent!.input.find((field) => field.name === "apply");
    expect(formatMethodParameter(apply!)).toBe("apply?: boolean = True");
  });

  it("renders array, enum, accepted, optional, and default field contracts", () => {
    const field: FieldDefinition = {
      name: "mode",
      type: "enum",
      accepts: ["result"],
      values: ["safe", "fast"],
      multiple: true,
      default: "safe"
    };
    expect(formatFieldType(field)).toBe('"safe" | "fast" | result | ("safe" | "fast" | result)[]');
    expect(formatMethodParameter(field)).toBe(
      'mode?: "safe" | "fast" | result | ("safe" | "fast" | result)[] = "safe"'
    );
  });

  it("uses a declared result type when the method declares one", () => {
    const api: CallableDefinition = {
      id: "mcp.team.query",
      title: "Query",
      description: "Query the team manifest",
      kind: "command",
      version: "1.0.0",
      input: [],
      output: { kind: "mcp.team.query", resultType: "DocumentResult" },
      executor: { kind: "deterministic", handler: "mcpTool" }
    };
    expect(methodResultType(api)).toBe("DocumentResult");
    // No declared type: the result is named after the output kind.
    expect(methodResultType({ ...api, output: { kind: "ask" } })).toBe("AskResult");
  });

  it("renders named shapes rather than expanding complex object parameters", () => {
    const form = BUILTIN_METHODS.find((method) => method.id === "ui.form");
    const fields = form!.input.find((field) => field.name === "fields");
    expect(formatMethodParameter(fields!)).toContain("fields: list[ui.Field]");
  });

  it("names the APIs whose per-call skills and rules stay caller-facing", () => {
    expect([...CONVERSATION_METHODS].sort()).toEqual(["agent", "ask", "plan", "template"]);
  });
});
