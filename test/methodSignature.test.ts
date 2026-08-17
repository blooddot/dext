import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { formatFieldType, formatMethodSignature } from "../src/core/methodSignature.js";
import type { CallableDefinition, FieldDefinition } from "../src/core/types.js";

describe("method signatures", () => {
  it("renders the complete public signature for a built-in API", () => {
    const agent = BUILTIN_METHODS.find((method) => method.id === "agent");
    expect(agent).toBeDefined();
    expect(formatMethodSignature(agent!)).toBe(
      "agent(input: string, apply?: boolean = True, workspace?: dir) -> AgentResult"
    );
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
    const api: CallableDefinition = {
      id: "sample.run",
      title: "Sample",
      description: "Sample API",
      kind: "command",
      version: "1.0.0",
      input: [field],
      output: { kind: "text" },
      executor: { kind: "deterministic", handler: "sample" }
    };
    expect(formatFieldType(field)).toBe('"safe" | "fast" | result | ("safe" | "fast" | result)[]');
    expect(formatMethodSignature(api)).toBe(
      'sample.run(mode?: "safe" | "fast" | result | ("safe" | "fast" | result)[] = "safe") -> TextResult'
    );
  });

  it("uses a declared custom result type", () => {
    const api: CallableDefinition = {
      id: "docs.read",
      title: "Read",
      description: "Read documents",
      kind: "command",
      version: "1.0.0",
      input: [],
      output: { kind: "document", resultType: "DocumentResult" },
      executor: { kind: "custom", apiId: "docs.read" }
    };
    expect(formatMethodSignature(api)).toBe("docs.read() -> DocumentResult");
  });

  it("renders MCP dictionary inputs with Python-like type notation", () => {
    const mcp = BUILTIN_METHODS.find((method) => method.id === "mcp");
    expect(formatMethodSignature(mcp!)).toBe(
      "mcp(tool: string, input: dict[str, object] = {}) -> McpRawResult"
    );
  });
});
