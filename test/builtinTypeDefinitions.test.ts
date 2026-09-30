import { describe, expect, it } from "vitest";
import { builtinTypeDefinition } from "../src/core/builtinTypeDefinitions.js";

describe("built-in Dext type definitions", () => {
  it("exposes the result shapes the runtime returns", () => {
    expect(builtinTypeDefinition("AgentResult")).toMatchObject({
      name: "AgentResult",
      fields: [
        { name: "kind", type: '"agent"' },
        { name: "text", type: "string" },
        { name: "summary", type: "string", optional: true },
        { name: "patch", type: "PatchResult", optional: true },
        { name: "files", type: "CodeRef[]", optional: true }
      ]
    });
    expect(builtinTypeDefinition("TerminalResult")?.fields.map((field) => field.name)).toEqual([
      "kind", "status", "command", "cwd", "exit_code", "stdout", "stderr", "duration_ms"
    ]);
    expect(builtinTypeDefinition("TerminalResult")?.fields.find((field) => field.name === "status"))
      .toMatchObject({ type: '"succeeded" | "failed" | "timed_out"' });
  });

  it("marks only the fields the runtime can omit as optional", () => {
    const agent = builtinTypeDefinition("AgentResult")!;
    const field = (name: string) => agent.fields.find((candidate) => candidate.name === name)!;
    expect(field("text")).toMatchObject({ type: "string" });
    expect(field("text").optional).toBeUndefined();
    expect(field("summary").optional).toBe(true);
    expect(field("patch").optional).toBe(true);
    expect(builtinTypeDefinition("TemplateResult")?.fields.map((candidate) => candidate.name)).toEqual(["kind", "text"]);
  });

  it("describes the form result and each answer", () => {
    const form = builtinTypeDefinition("UiFormResult")!;
    // The runtime always sets the discriminators and the interaction payload.
    expect(form.fields.every((field) => !field.optional)).toBe(true);
    expect(form.fields.find((field) => field.name === "type")).toMatchObject({ type: '"form"' });
    expect(form.fields.find((field) => field.name === "status")).toMatchObject({ type: '"submitted" | "cancelled"' });
    expect(form.fields.find((field) => field.name === "answers")).toMatchObject({ type: "dict[str, UiFieldAnswer]" });
    expect(builtinTypeDefinition("UiFieldAnswer")?.fields.map((field) => field.name))
      .toEqual(["type", "selected", "custom", "value"]);
  });

  it("keeps PatchResult as an AgentResult payload and never exposes PrintResult", () => {
    const patch = builtinTypeDefinition("AgentResult")!.fields.find((field) => field.name === "patch")!;
    expect(patch).toMatchObject({ type: "PatchResult", optional: true });
    expect(builtinTypeDefinition("PrintResult")).toBeUndefined();
    expect(builtinTypeDefinition("print")).toBeUndefined();
  });

  it("covers the model option dictionary and form field shapes", () => {
    expect(builtinTypeDefinition("agent.ModelOptions")?.fields.map((field) => field.name))
      .toEqual(["model", "reasoning", "speed"]);
    expect(builtinTypeDefinition("ui.Field")?.fields.find((field) => field.name === "options"))
      .toMatchObject({ type: "list[string | ui.Option]", optional: true });
  });
});
