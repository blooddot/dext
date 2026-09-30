import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { formatFieldType, formatMethodSignature } from "../src/core/methodSignature.js";
import type { CallableDefinition, FieldDefinition } from "../src/core/types.js";

describe("method signatures", () => {
  it("renders the complete public signature for a built-in API", () => {
    const agent = BUILTIN_METHODS.find((method) => method.id === "agent");
    expect(agent).toBeDefined();
    const cliParameters = ', cli?: "codex" | "claude" | "deepseek-harness", model?: "sonnet" | "opus" | agent.ModelOptions';
    expect(formatMethodSignature(agent!)).toBe(
      `agent(input: string, apply?: boolean = True, patch?: boolean = True, workspace?: dir${cliParameters}) -> AgentResult`
    );
    expect(formatMethodSignature(agent!, { includeInternal: true })).toBe(
      `agent(input: string, apply?: boolean = True, patch?: boolean = True, skills?: string | string[], rules?: string | string[], workspace?: dir${cliParameters}) -> AgentResult`
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
      output: { kind: "terminal" },
      executor: { kind: "deterministic", handler: "sample" }
    };
    expect(formatFieldType(field)).toBe('"safe" | "fast" | result | ("safe" | "fast" | result)[]');
    expect(formatMethodSignature(api)).toBe(
      'sample.run(mode?: "safe" | "fast" | result | ("safe" | "fast" | result)[] = "safe") -> TerminalResult'
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
    expect(formatMethodSignature(api)).toBe("mcp.team.query() -> DocumentResult");
  });

  it("renders named shapes rather than expanding complex object parameters", () => {
    const form = BUILTIN_METHODS.find((method) => method.id === "ui.form");
    expect(formatMethodSignature(form!)).toContain("fields: list[ui.Field]");
  });

});
