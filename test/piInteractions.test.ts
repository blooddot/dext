import { describe, expect, it } from "vitest";
import { piQuestion, piUi } from "../src/features/agents/host/piInteractions.js";
import { agentTimeout } from "../src/features/agents/domain/agentTimeout.js";
import type { AgentConversationRequest } from "../src/features/agents/host/agentRunner.js";
import type { AgentStreamEvent } from "../src/shared/contracts/types.js";
describe("Pi interactions", () => {
  it("round-trips multi-select and custom answers without recording secrets", async () => {
    const events: AgentStreamEvent[] = [], controller = new AbortController(), timeout = agentTimeout(controller, 0, 0);
    const request = { metadata: { requestAgentInput: async () => ({ q: { answers: ["A", "custom"] }, secret: { answers: ["private"] } }) }, onEvent: (event: AgentStreamEvent) => events.push(event) } as unknown as AgentConversationRequest;
    const outcome = await piQuestion(request, "request", [{ id: "q", header: "", question: "Choose", multiSelect: true, options: [{ label: "A", description: "" }] }, { id: "secret", header: "", question: "Token", options: [], isSecret: true }], controller.signal, timeout);
    expect(outcome).toMatchObject({ status: "answered", answers: { q: { answers: ["A", "custom"] }, secret: { answers: ["private"] } } });
    expect(events.map((event) => event.userInput?.status)).toEqual(["waiting", "answered"]);
    expect(JSON.stringify(events)).not.toContain("private"); timeout.dispose();
  });
  it("maps native select, confirm, and cancellation while ignoring editor mutations", async () => {
    const controller = new AbortController(), timeout = agentTimeout(controller, 0, 0);
    const request = { metadata: { ui: { form: async () => ({ kind: "ui", type: "form", status: "submitted", answers: { answer: { type: "select", selected: ["B"] } } }) } } } as unknown as AgentConversationRequest;
    expect(await piUi(request, { type: "extension_ui_request", id: "s", method: "select", title: "Choose", options: ["A", "B"] }, controller.signal, timeout)).toMatchObject({ id: "s", value: "B" });
    expect(await piUi(request, { type: "extension_ui_request", id: "c", method: "confirm", title: "Continue" }, controller.signal, timeout)).toMatchObject({ confirmed: true });
    expect(await piUi(request, { type: "extension_ui_request", id: "e", method: "set_editor_text", text: "overwrite" }, controller.signal, timeout)).toBeUndefined();
    controller.abort(); expect(await piUi(request, { type: "extension_ui_request", id: "late", method: "input" }, controller.signal, timeout)).toMatchObject({ cancelled: true }); timeout.dispose();
  });
});
