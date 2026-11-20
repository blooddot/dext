import { describe, expect, it } from "vitest";
import { builtinTypeDefinition, RESERVED_UI_TYPE_DEFINITIONS } from "../src/features/workflow/domain/builtinTypeDefinitions.js";

describe("built-in Dext type definitions", () => {
  it("declares Pi model identity and dynamic reasoning without Codex speed", () => {
    expect(builtinTypeDefinition("agent.PiModelOptions")?.fields).toEqual([
      { name: "model", type: "string", description: "Pi provider/modelId." }, { name: "reasoning", type: "string", optional: true }
    ]);
  });
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

  it("records the recursive UI node schema and reserves Tier 2 without public variants", () => {
    const node = builtinTypeDefinition("ui.Node")!;
    const line = builtinTypeDefinition("ui.TraceLine")!;
    const lineChild = builtinTypeDefinition("ui.TraceLineChild")!;
    expect(node.alias).toContain("ui.TraceLine");
    expect(line.fields).toContainEqual({ name: "children", type: "list[ui.TraceLineChild]" });
    expect(lineChild.alias).toContain('type: "Trace"; ordered?: boolean; children: list[ui.TraceLine]');
    expect(builtinTypeDefinition("ViewResult")?.fields).toEqual([
      { name: "kind", type: '"view"' }, { name: "nodes", type: "list[ui.Node]" }
    ]);
    expect(RESERVED_UI_TYPE_DEFINITIONS).toHaveLength(12);
    for (const entry of RESERVED_UI_TYPE_DEFINITIONS) {
      expect(entry.status).toBe("reserved");
      expect(node.alias).not.toContain(`"${entry.name}"`);
      expect(builtinTypeDefinition(`ui.${entry.name}`)).toBeUndefined();
    }
  });
});
