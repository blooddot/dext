import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { elicitationQuestions, elicitationResponse, harnessInputQuestions, harnessQuestionAnswer, parseHarnessQuestionRequest } from "../src/core/harnessQuestions.js";

const form = (properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest =>
  ({ mode: "form", sessionId: "s", message: "Pick", requestedSchema: { type: "object", required, properties } }) as CreateElicitationRequest;

describe("Harness bridge questions", () => {
  const payload = { id: "req-1", questions: [
    { id: "mode", question: "Which mode?", header: "Choose", detail: "One only", options: [
      { label: "Fast", description: "Cheaper" }, { label: "Thorough" }
    ] },
    { id: "targets", question: "Which targets?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
    { id: "note", question: "Anything else?" }
  ] };

  it("accepts a complete batch and projects it into the shared question shape", () => {
    const request = parseHarnessQuestionRequest(payload);
    expect(request?.id).toBe("req-1");
    expect(harnessInputQuestions(request!.questions)).toEqual([
      { id: "mode", header: "Choose", question: "Which mode?", detail: "One only",
        options: [{ label: "Fast", description: "Cheaper" }, { label: "Thorough", description: "" }] },
      { id: "targets", header: "", question: "Which targets?", multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      { id: "note", header: "", question: "Anything else?", options: [] }
    ]);
  });

  it("rejects partial, duplicate and oversized batches instead of rendering them", () => {
    expect(parseHarnessQuestionRequest({ id: "r", questions: [] })).toBeUndefined();
    expect(parseHarnessQuestionRequest({ questions: payload.questions })).toBeUndefined();
    expect(parseHarnessQuestionRequest({ id: "r", questions: [{ id: "a" }] })).toBeUndefined();
    expect(parseHarnessQuestionRequest({ id: "r", questions: [{ id: "a", question: "x", options: [{ label: "" }] }] })).toBeUndefined();
    expect(parseHarnessQuestionRequest({ id: "r", questions: [{ id: "a", question: "x" }, { id: "a", question: "y" }] })).toBeUndefined();
    expect(parseHarnessQuestionRequest("nope")).toBeUndefined();
  });

  it("encodes answers the way the Harness seam reads them", () => {
    const questions = harnessInputQuestions(parseHarnessQuestionRequest(payload)!.questions);
    expect(harnessQuestionAnswer(questions, { mode: { answers: ["Fast"] }, targets: { answers: ["A", "B"] }, note: { answers: ["hi"] } }))
      .toEqual({ answers: [{ id: "mode", selected: ["Fast"] }, { id: "targets", selected: ["A", "B"] }, { id: "note", selected: [], custom: "hi" }] });
    // A typed answer on a single-select question is the custom answer, never a selection.
    expect(harnessQuestionAnswer(questions, { mode: { answers: ["Something else"] }, targets: { answers: ["A"] }, note: { answers: ["hi"] } })?.answers[0])
      .toEqual({ id: "mode", selected: [], custom: "Something else" });
  });

  it("refuses answers it cannot encode, so the agent is never told a wrong choice", () => {
    const questions = harnessInputQuestions(parseHarnessQuestionRequest(payload)!.questions);
    expect(harnessQuestionAnswer(questions, null)).toBeUndefined();
    expect(harnessQuestionAnswer(questions, { mode: { answers: ["Fast"] } })).toBeUndefined();
    expect(harnessQuestionAnswer(questions, { mode: { answers: ["Fast", "Thorough"] }, targets: { answers: ["A"] }, note: { answers: ["hi"] } })).toBeUndefined();
    expect(harnessQuestionAnswer(questions, { mode: { answers: ["Fast"] }, targets: { answers: ["A"] }, note: { answers: [" "] } })).toBeUndefined();
  });
});

describe("ACP elicitation forms", () => {
  it("maps titled, plain, multi-select, boolean and numeric properties", () => {
    expect(elicitationQuestions(form({
      scope: { type: "string", title: "Scope", description: "Where", oneOf: [
        { const: "workspace", title: "Workspace" }, { const: "user", title: "User", description: "All projects" }
      ] },
      level: { type: "string", title: "Level", enum: ["low", "high"] },
      tags: { type: "array", title: "Tags", items: { anyOf: [{ const: "a", title: "Alpha" }] } },
      confirm: { type: "boolean", title: "Confirm" },
      count: { type: "integer", title: "Count" },
      notes: { type: "string", title: "Notes" }
    }))).toEqual([
      { id: "scope", header: "", question: "Scope", detail: "Where",
        options: [{ label: "Workspace", description: "" }, { label: "User", description: "All projects" }] },
      { id: "level", header: "", question: "Level", options: [{ label: "low", description: "" }, { label: "high", description: "" }] },
      { id: "tags", header: "", question: "Tags", options: [{ label: "Alpha", description: "" }] },
      { id: "confirm", header: "", question: "Confirm", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] },
      { id: "count", header: "", question: "Count", options: [] },
      { id: "notes", header: "", question: "Notes", options: [] }
    ]);
  });

  it("declines schemas it cannot round-trip instead of rendering them partially", () => {
    expect(elicitationQuestions(form({ level: { type: "string", title: "Level", enum: [] } }))).toBeUndefined();
    expect(elicitationQuestions(form({ blob: { type: "_vendor", title: "Blob" } }))).toBeUndefined();
    expect(elicitationQuestions(form({}))).toBeUndefined();
    expect(elicitationQuestions({ mode: "url", sessionId: "s", url: "https://example.com", elicitationId: "e", message: "Go" })).toBeUndefined();
  });

  it("answers with the declared value behind the label the user read", () => {
    const request = form({ scope: { type: "string", title: "Scope", oneOf: [
      { const: "workspace", title: "Workspace" }, { const: "user", title: "User" }
    ] }, notes: { type: "string", title: "Notes" } });
    expect(elicitationResponse(request, { scope: { answers: ["User"] }, notes: { answers: ["typed"] } }))
      .toEqual({ action: "accept", content: { scope: "user", notes: "typed" } });
    expect(elicitationResponse(request, { scope: { answers: ["bespoke"] }, notes: { answers: ["typed"] } }))
      .toEqual({ action: "accept", content: { scope: "bespoke", notes: "typed" } });
  });

  it("maps booleans, numbers and multi-select arrays to their wire values", () => {
    const request = form({ confirm: { type: "boolean" }, count: { type: "number" }, tags: { type: "array", items: { enum: ["a", "b"] } } });
    expect(elicitationResponse(request, { confirm: { answers: ["No"] }, count: { answers: ["3.5"] }, tags: { answers: ["a", "b"] } }))
      .toEqual({ action: "accept", content: { confirm: false, count: 3.5, tags: ["a", "b"] } });
    expect(elicitationResponse(request, { confirm: { answers: ["Maybe"] }, count: { answers: ["3"] }, tags: { answers: ["a"] } }))
      .toEqual({ action: "decline" });
  });

  it("reports a skipped card as cancelled and a missing answer as declined", () => {
    const request = form({ scope: { type: "string", title: "Scope" } });
    expect(elicitationResponse(request, null)).toEqual({ action: "cancel" });
    expect(elicitationResponse(request, { scope: { answers: [] } })).toEqual({ action: "decline" });
    expect(elicitationResponse({ mode: "url", sessionId: "s", url: "https://example.com", elicitationId: "e", message: "Go" }, null)).toEqual({ action: "decline" });
  });
});
