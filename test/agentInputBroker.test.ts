import { describe, expect, it } from "vitest";
import { AgentInputBroker } from "../src/agentInputBroker.js";
const question = { id: "request", blocking: true, questions: [{ id: "q", header: "", question: "Which?", options: [] }] };
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
