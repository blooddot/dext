import { describe, expect, it } from "vitest";
import { answerChoices, uiFieldChoices } from "../src/uiInteractionPresentation.js";
import { parseUiForm, type UiField } from "../src/core/uiForm.js";

function field(definition: Record<string, unknown>): UiField {
  return parseUiForm({ title: "Question", fields: [definition] }).fields[0]!;
}

describe("choices a submitted question offered", () => {
  it("keeps the offered order and marks the picked options", () => {
    const choices = answerChoices([
      { value: "index", label: "Index only", description: "Cheapest to keep in sync." },
      { value: "files", label: "Files" },
      { value: "both", label: "Both" }
    ], ["both", "index"]);
    expect(choices).toEqual([
      { label: "Index only", description: "Cheapest to keep in sync.", selected: true },
      { label: "Files", selected: false },
      { label: "Both", selected: true }
    ]);
  });
  it("marks an Agent answer by its label even though options carry no value", () => {
    const choices = answerChoices([{ label: "First", description: "The first one." }, { label: "Second", description: "" }], ["First"]);
    expect(choices).toEqual([
      { label: "First", description: "The first one.", selected: true },
      { label: "Second", selected: false }
    ]);
  });
  it("appends a typed answer as its own selected row and ignores blank or repeated ones", () => {
    const choices = answerChoices([{ value: "index", label: "Index only" }], ["Derive it", "  ", "Derive it", "index"]);
    expect(choices).toEqual([
      { label: "Index only", selected: true },
      { label: "Derive it", selected: true, custom: true }
    ]);
  });
  it("offers no choices for an input field", () => {
    expect(uiFieldChoices(field({ id: "notes", type: "input", label: "Notes", required: false }), { type: "input", value: "text" })).toEqual([]);
  });
  it("lists a radio's options beside the typed answer that replaced them", () => {
    const where = field({ id: "where", type: "radio", label: "Where?", allow_custom: true,
      options: [{ value: "index", label: "Index only" }, { value: "files", label: "Files" }] });
    expect(uiFieldChoices(where, { type: "radio", selected: [], custom: "Derive it" })).toEqual([
      { label: "Index only", selected: false },
      { label: "Files", selected: false },
      { label: "Derive it", selected: true, custom: true }
    ]);
  });
  it("keeps every checkbox selection without inventing a custom row", () => {
    const pick = field({ id: "pick", type: "checkbox", label: "Pick", allow_custom: true,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    expect(uiFieldChoices(pick, { type: "checkbox", selected: ["a", "b"] })).toEqual([
      { label: "A", selected: true },
      { label: "B", selected: true }
    ]);
  });
});
