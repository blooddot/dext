import { describe, expect, it } from "vitest";
import { PLAN_DOCUMENT_END, PLAN_DOCUMENT_START } from "../src/core/planResponse.js";
import { PlanDocumentFilter, guardPlanDocumentEvents } from "../src/core/planDocumentStream.js";
import type { AgentStreamEvent } from "../src/core/types.js";

function collected(): { events: AgentStreamEvent[]; guard: (event: AgentStreamEvent) => void } {
  const events: AgentStreamEvent[] = [];
  return { events, guard: guardPlanDocumentEvents((event) => events.push(event)) };
}

describe("Plan document stream guard", () => {
  it("accumulates split delimiters per message and hides the document", () => {
    const filter = new PlanDocumentFilter();
    expect(filter.push("m", "Intro. ")).toEqual({ text: "Intro. ", replace: false });
    expect(filter.push("m", "<!-- dext-pl")).toEqual({ text: "<!-- dext-pl", replace: false });
    expect(filter.push("m", "an:start -->\n# Plan")).toEqual({ text: "Intro.", replace: true });
    expect(filter.push("m", "\nmore plan")).toBeUndefined();
    expect(filter.push("m", `\n${PLAN_DOCUMENT_END}\nTail.`)).toEqual({ text: "Intro.\n\nTail.", replace: true });
    expect(filter.push("m", " More.")).toEqual({ text: " More.", replace: false });
    expect(filter.complete("m", `Intro. ${PLAN_DOCUMENT_START}\n# Plan\n${PLAN_DOCUMENT_END}\nTail. More.`))
      .toBe("Intro.\n\nTail. More.");
  });

  it("separates a reply that keeps streaming after the closing delimiter", () => {
    const filter = new PlanDocumentFilter();
    expect(filter.push("m", "Intro. ")).toEqual({ text: "Intro. ", replace: false });
    expect(filter.push("m", PLAN_DOCUMENT_START)).toEqual({ text: "Intro.", replace: true });
    expect(filter.push("m", "\n# Plan\n")).toBeUndefined();
    expect(filter.push("m", PLAN_DOCUMENT_END)).toBeUndefined();
    expect(filter.push("m", "Tail.")).toEqual({ text: "\n\nTail.", replace: false });
    expect(filter.push("m", " More.")).toEqual({ text: " More.", replace: false });
    expect(filter.complete("m", `Intro. ${PLAN_DOCUMENT_START}\n# Plan\n${PLAN_DOCUMENT_END}Tail. More.`))
      .toBe("Intro.\n\nTail. More.");
  });

  it("guards a delta stream plus its completed snapshot", () => {
    const { events, guard } = collected();
    const reply = `Brief. ${PLAN_DOCUMENT_START}\n# Private plan\n${PLAN_DOCUMENT_END}\nTail.`;
    guard({ id: "m", phase: "message", text: "Brief. " });
    guard({ id: "m", phase: "message", text: "<!-- dext-plan:start -->" });
    guard({ id: "m", phase: "message", text: "\n# Private plan\n" });
    guard({ id: "m", phase: "message", text: "<!-- dext-plan:end -->" });
    guard({ id: "m", phase: "message", text: reply, replace: true, done: true });

    expect(events.map((event) => event.text)).toEqual(["Brief. ", "Brief.", "Brief.\n\nTail."]);
    expect(events.every((event) => !(event.text ?? "").includes("dext-plan"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ id: "m", replace: true, done: true, text: "Brief.\n\nTail." });
  });

  it("covers providers that only stream chunks and never send a snapshot", () => {
    const { events, guard } = collected();
    guard({ id: "work", phase: "message", text: "Brief. " });
    guard({ id: "work", phase: "message", text: PLAN_DOCUMENT_START });
    guard({ id: "work", phase: "message", text: "\n# Plan\n" });
    guard({ id: "work", phase: "message", text: PLAN_DOCUMENT_END });
    guard({ id: "work", phase: "message", text: "Tail." });

    expect(events.map((event) => event.text)).toEqual(["Brief. ", "Brief.", "\n\nTail."]);
    expect(events.some((event) => (event.text ?? "").includes("dext-plan"))).toBe(false);
  });

  it("uses stable ids to hide documents across replaced snapshots", () => {
    const { events, guard } = collected();
    guard({ id: "m", phase: "message", text: `Intro.\n${PLAN_DOCUMENT_START}`, replace: true });
    guard({ id: "m", phase: "message", text: `Intro.\n${PLAN_DOCUMENT_START}\n# Plan`, replace: true });
    guard({ id: "m", phase: "message", text: `Intro.\n${PLAN_DOCUMENT_START}\n# Plan\n${PLAN_DOCUMENT_END}`, replace: true, done: true });

    expect(events.map((event) => event.text)).toEqual(["Intro.", "Intro.", "Intro."]);
  });

  it("passes non-message phases and ordinary messages through", () => {
    const { events, guard } = collected();
    const tool: AgentStreamEvent = { phase: "tool", id: "cmd", text: "npm test" };
    guard(tool);
    guard({ id: "note", phase: "message", text: "Working on it." });
    expect(events).toEqual([tool, { id: "note", phase: "message", text: "Working on it." }]);
  });

  it("strips anonymous messages when the document is complete", () => {
    const { events, guard } = collected();
    guard({ phase: "message", text: `Summary\n${PLAN_DOCUMENT_START}\n# Plan\n${PLAN_DOCUMENT_END}` });
    expect(events).toEqual([{ phase: "message", text: "Summary" }]);
  });
});
