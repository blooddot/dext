import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { describe, expect, it } from "vitest";
import { parseUiForm, uiCallForm, uiCallResult, validateUiAnswers, UI_LIMITS } from "../src/core/uiForm.js";
import { uiResultSchema } from "../src/core/schemas.js";

const radio = { id: "decision", type: "radio", label: "Run tests?", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] };
const form = (fields: unknown[] = [radio]) => parseUiForm({ title: "Settings", fields });
describe("public interaction contract", () => {
  it("keeps no, unanswered and cancelled distinct", () => {
    const definition = form();
    expect(definition.fields[0]?.default).toBeUndefined();
    expect(() => validateUiAnswers(definition, {})).toThrow("required");
    expect(validateUiAnswers(definition, { decision: { type: "radio", selected: ["no"] } })).toEqual({ decision: { type: "radio", selected: ["no"] } });
    expect(uiResultSchema.safeParse({ kind: "ui", type: "form", status: "cancelled", answers: { decision: { type: "radio", selected: ["no"] } } }).success).toBe(false);
  });
  it.each([
    [radio, radio], [{ ...radio, options: ["same", "same"] }], [{ ...radio, multiple: true }],
    [{ ...radio, default: ["unknown"] }], [{ ...radio, default: ["yes", "no"] }], [{ ...radio, default: [] }],
    [{ ...radio, type: "select", allow_custom: true }], [{ ...radio, type: "boolean" }],
    [{ ...radio, id: "__proto__" }], [{ ...radio, id: "constructor" }],
    [{ id: "x", type: "input", label: "X", secret: true }],
    [{ id: "x", type: "input", label: "X", default: " " }]
  ])("rejects invalid field descriptions: %j", (...fields) => { expect(() => form(fields)).toThrow(); });
  it("bounds the whole request, not only individual fields", () => {
    expect(() => form(Array.from({ length: UI_LIMITS.fields + 1 }, (_, index) => ({ ...radio, id: String(index) })))).toThrow();
    expect(() => form([{ ...radio, options: Array(201).fill("a") }])).toThrow();
    expect(() => form(Array.from({ length: 20 }, (_, index) => ({ id: String(index), type: "input", label: "x", description: "中".repeat(15000) })))).toThrow("size");
  });
  it.each([
    { decision: { type: "radio", selected: ["yes", "no"] } },
    { decision: { type: "radio", selected: ["yes", "yes"] } },
    { decision: { type: "radio", selected: ["unknown"] } },
    { decision: { type: "radio", selected: ["yes"], custom: "other" } },
    { decision: { type: "checkbox", selected: ["yes"] } },
    { extra: { type: "input", value: "x" } }
  ])("rejects an answer not matching the original request: %j", (answers) => { expect(() => validateUiAnswers(form(), answers)).toThrow(); });
  it("checks custom exclusivity, duplicates and optional emptiness", () => {
    const single = form([{ ...radio, allow_custom: true }]);
    expect(() => validateUiAnswers(single, { decision: { type: "radio", selected: ["yes"], custom: "other" } })).toThrow("exclusive");
    const multi = form([{ ...radio, type: "checkbox", allow_custom: true, required: false }]);
    expect(validateUiAnswers(multi, { decision: { type: "checkbox", selected: ["yes"], custom: " other " } })).toEqual({ decision: { type: "checkbox", selected: ["yes"], custom: " other " } });
    expect(() => validateUiAnswers(multi, { decision: { type: "checkbox", selected: ["yes", "yes"] } })).toThrow("duplicate");
    expect(validateUiAnswers(multi, { decision: { type: "checkbox", selected: [], custom: " " } })).toEqual({});
  });
  it("preserves input text but omits optional blanks in forms", () => {
    const definition = form([{ id: "text", type: "input", label: "Text", required: false }]);
    expect(validateUiAnswers(definition, { text: { type: "input", value: "  text\n" } }).text).toEqual({ type: "input", value: "  text\n" });
    expect(validateUiAnswers(definition, { text: { type: "input", value: " " } })).toEqual({});
    const shortcut = uiCallForm("input", { label: "Text" });
    expect(validateUiAnswers(shortcut, { answer: { type: "input", value: "" } }).answer).toEqual({ type: "input", value: "" });
  });
  it("expresses empty confirmation and alert forms with distinct results", () => {
    expect(validateUiAnswers(form([]), {})).toEqual({});
    const submitted = { kind: "ui", type: "form", status: "submitted", answers: {} } as const;
    const cancelled = { ...submitted, status: "cancelled" } as const;
    expect(uiCallResult("alert", submitted)).toEqual({ kind: "ui", type: "alert", status: "acknowledged" });
    expect(uiCallResult("alert", cancelled)).toEqual({ kind: "ui", type: "alert", status: "dismissed" });
    expect(uiCallResult("confirm", cancelled)).toEqual({ kind: "ui", type: "confirm", confirmed: false });
    for (const type of ["select", "radio", "checkbox"] as const) expect(uiCallResult(type, cancelled)).toEqual({ kind: "ui", type, selected: [] });
  });
  it("keeps shortcut defaults independent of field defaults", () => {
    expect(uiCallForm("radio", { label: "Pick", options: ["a", "b"] }).fields[0]?.default).toEqual(["a"]);
    expect(uiCallForm("checkbox", { label: "Pick", options: ["a", "b"] }).fields[0]?.required).toBe(false);
    expect(uiCallForm("select", { label: "Pick", options: ["a", "b"] }).fields[0]?.default).toBeUndefined();
    expect(uiCallForm("alert", { message: "Read this" }).show_cancel).toBe(false);
  });
  it("rejects removed results and objects masquerading as complete results", () => {
    expect(uiResultSchema.safeParse({ kind: "ui", type: "choice", selected: [] }).success).toBe(false);
    expect(uiResultSchema.safeParse({ type: "input", value: "x" }).success).toBe(false);
    expect(uiResultSchema.safeParse({ kind: "ui", type: "select", selected: [], custom: "x" }).success).toBe(false);
  });
});

const feedback = { id: "feedback", type: "input", label: "Feedback", required: false, multiline: true };
const branching = (actions: unknown[]) => parseUiForm({ title: "Review", fields: [feedback], actions });
describe("form actions", () => {
  it("falls back to a single submit action so existing forms keep working", () => {
    expect(form().actions).toEqual([{ id: "submit", label: "Submit", primary: true, requires: [] }]);
    expect(parseUiForm({ title: "Settings", fields: [], submit_label: "Go" }).actions[0]).toMatchObject({ id: "submit", label: "Go" });
    expect(uiCallForm("confirm", { message: "Sure?", confirm_label: "Do it" }).actions).toEqual([{ id: "submit", label: "Do it", primary: true, requires: [] }]);
  });
  it("promotes the first action when the caller marks none as primary", () => {
    const declared = branching([{ id: "revise", label: "Revise" }, { id: "approve", label: "Approve" }]);
    expect(declared.actions.map((action) => action.primary)).toEqual([true, false]);
    expect(branching([{ id: "revise", label: "Revise" }, { id: "approve", label: "Approve", primary: true }])
      .actions.map((action) => action.primary)).toEqual([false, true]);
  });
  it("requires a field for the action that asks for it and leaves the others alone", () => {
    const definition = branching([{ id: "revise", label: "Revise", requires: ["feedback"] }, { id: "approve", label: "Approve", primary: true }]);
    expect(() => validateUiAnswers(definition, { feedback: { type: "input", value: " " } }, "revise")).toThrow("enter a value");
    expect(() => validateUiAnswers(definition, {}, "revise")).toThrow("required");
    expect(validateUiAnswers(definition, {}, "approve")).toEqual({});
    expect(validateUiAnswers(definition, { feedback: { type: "input", value: "why" } }, "revise")).toEqual({ feedback: { type: "input", value: "why" } });
    expect(validateUiAnswers(definition, {})).toEqual({});
    expect(() => validateUiAnswers(definition, {}, "unknown")).toThrow("Unknown form action");
  });
  it.each([
    [[{ id: "a", label: "A" }, { id: "a", label: "Again" }]],
    [[{ id: "__proto__", label: "A" }]],
    [[{ id: "a", label: "A", requires: ["missing"] }]],
    [[{ id: "a", label: "A", requires: ["feedback", "feedback"] }]],
    [[{ id: "a", label: "A", style: "primary" }]],
    [Array.from({ length: 9 }, (_, index) => ({ id: String(index), label: "A" }))]
  ])("rejects invalid action lists: %j", (actions) => { expect(() => branching(actions)).toThrow(); });
  it("reports the pressed action and keeps cancellation empty", () => {
    const cancelled = { kind: "ui", type: "form", status: "cancelled", answers: {} } as const;
    expect(uiCallResult("form", cancelled)).toEqual({ ...cancelled, action: "" });
    expect(uiCallResult("form", { kind: "ui", type: "form", status: "submitted", answers: {}, action: "approve" }))
      .toMatchObject({ action: "approve" });
    expect(uiResultSchema.safeParse({ ...cancelled, action: "approve" }).success).toBe(false);
  });
});

it("does not let completion metadata relax executable UI output validation", () => {
  const ax = new AxAdapter(); const radio = ax.compile(BUILTIN_METHODS.find((method) => method.id === "ui.radio")!);
  expect(radio.outputSchema.safeParse({ kind: "ui", type: "checkbox", selected: [] }).success).toBe(false);
  expect(radio.outputSchema.safeParse({ kind: "ui", type: "radio", selected: ["a", "b"] }).success).toBe(false);
  const form = ax.compile(BUILTIN_METHODS.find((method) => method.id === "ui.form")!);
  expect(form.outputSchema.safeParse({ kind: "ui", type: "form", status: "submitted", action: "submit", answers: { selected: { type: "radio", selected: ["a"] } } }).success).toBe(true);
  expect(form.outputSchema.safeParse({ kind: "ui", type: "form", status: "submitted", action: "submit", answers: { x: { type: "boolean", value: true } } }).success).toBe(false);
});
