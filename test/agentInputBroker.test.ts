import { describe, expect, it } from "vitest";
import { AgentInputBroker } from "../src/agentInputBroker.js";
import { agentInputForm } from "../src/uiInteractionPresentation.js";
const question = { id: "request", blocking: true, questions: [{ id: "q", header: "", question: "Which?", options: [] }] };
const multi = { id: "request", blocking: true, questions: [{ id: "q", header: "", question: "Which?", multiSelect: true,
  detail: "Pick any", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] };
const answers = { q: { answers: ["Custom response"] } };

describe("live question ownership", () => {
  it("ignores foreign sessions, stale turns and invalid answers", async () => {
    const broker = new AgentInputBroker(); const controller = new AbortController();
    const pending = broker.request("session", "turn", question, controller.signal);
    let settled = false; void pending.then(() => { settled = true; });
    broker.respond("other", "turn", "request", answers);
    broker.respond("session", "old-turn", "request", answers);
    broker.respond("session", "turn", "request", { wrong: { answers: ["No"] } });
    broker.respond("session", "turn", "request", { q: { answers: [" "] } });
    await Promise.resolve(); expect(settled).toBe(false);
    broker.respond("session", "turn", "request", answers);
    expect(await pending).toEqual(answers);
    broker.respond("session", "turn", "request", null);
  });
  it("clears requests on abort and disposal", async () => {
    const broker = new AgentInputBroker(); const controller = new AbortController();
    const pending = broker.request("session", "turn", question, controller.signal);
    controller.abort(); expect(await pending).toBeNull();
    const next = broker.request("session", "next", question, new AbortController().signal);
    broker.dispose(); expect(await next).toBeNull();
    expect(await broker.request("session", "turn", question, controller.signal)).toBeNull();
  });
});

describe("multi-select questions", () => {
  it("renders as a checkbox field carrying the question's detail", () => {
    expect(agentInputForm(multi).fields[0]).toMatchObject({
      id: "q", type: "checkbox", label: "Which?", description: "Pick any", allow_custom: true,
      options: [{ value: "A", label: "A", description: "" }, { value: "B", label: "B", description: "" }]
    });
  });
  it("keeps every selection while a single-select question keeps exactly one", async () => {
    const broker = new AgentInputBroker(); const controller = new AbortController();
    const pending = broker.request("session", "turn", multi, controller.signal);
    broker.respond("session", "turn", "request", { q: { answers: ["A", "B", "typed"] } });
    expect(await pending).toEqual({ q: { answers: ["A", "B", "typed"] } });

    const single = new AgentInputBroker(); const other = new AbortController();
    const one = single.request("session", "turn", question, other.signal);
    let settled = false; void one.then(() => { settled = true; });
    single.respond("session", "turn", "request", { q: { answers: ["A", "B"] } });
    await Promise.resolve(); expect(settled).toBe(false);
    single.respond("session", "turn", "request", { q: { answers: ["A"] } });
    expect(await one).toEqual({ q: { answers: ["A"] } });
  });
});
