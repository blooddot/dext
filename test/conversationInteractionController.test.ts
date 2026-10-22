import { describe, expect, it } from "vitest";
import { uiCallForm } from "../src/shared/contracts/uiForm.js";
import type { AgentStreamEvent } from "../src/shared/contracts/types.js";
import { InteractionController } from "../src/features/conversations/host/interactionController.js";
import type { InputNotificationTarget } from "../src/features/conversations/host/inputNotifications.js";
import { conversation, createConversationHarness } from "./conversationHarness.js";

const form = () => uiCallForm("form", {
  title: "Review",
  fields: [{ id: "approve", type: "radio", label: "Approve", options: ["Yes", "No"] }]
});

describe("InteractionController", () => {
  it("matches a form response to its own session, turn and request", async () => {
    const h = createConversationHarness();
    const events: AgentStreamEvent[] = [];
    const ui = h.interactions.uiInteraction("session", "turn", (event) => events.push(event));
    const waiting = ui.form(form());
    const state = events.at(-1)?.uiInteraction;
    expect(state?.status).toBe("waiting");
    const answer = { kind: "ui", type: "form", status: "submitted", answers: { approve: { type: "radio", selected: ["Yes"] } } };
    // Another turn or another request cannot answer this card.
    expect(h.interactions.respondUi("session", "other-turn", state!.requestId, answer)).toBe(false);
    expect(h.interactions.respondUi("session", "turn", "unknown", answer)).toBe(false);
    expect(h.interactions.respondUi("session", "turn", state!.requestId, answer)).toBe(true);
    await expect(waiting).resolves.toMatchObject({ status: "submitted" });
    // A duplicate response is no longer owned by anything.
    expect(h.interactions.respondUi("session", "turn", state!.requestId, answer)).toBe(false);
  });

  it("ends a waiting form when its turn is cancelled", async () => {
    const h = createConversationHarness();
    const ui = h.interactions.uiInteraction("session", "turn", () => undefined);
    const controller = new AbortController();
    const waiting = ui.form(form(), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("answers an agent question only through the matching request", async () => {
    const h = createConversationHarness();
    const controller = new AbortController();
    const request = {
      id: "question",
      blocking: true,
      questions: [{ id: "choice", header: "Pick", question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }]
    };
    const waiting = h.interactions.requestAgentInput("session", "turn", request as never, controller.signal);
    h.interactions.respondAgent("session", "other-turn", "question", { choice: { answers: ["A"] } });
    h.interactions.respondAgent("session", "turn", "unknown", { choice: { answers: ["A"] } });
    h.interactions.respondAgent("session", "turn", "question", { choice: { answers: ["A"] } });
    await expect(waiting).resolves.toEqual({ choice: { answers: ["A"] } });
  });

  it("notifies for a waiting question and hands the focus only to the visible turn", () => {
    const targets: InputNotificationTarget[] = [];
    const controller = new InteractionController({
      notify: async () => true,
      open: async (target) => { targets.push(target); },
      turnOf: (sessionId) => sessionId === "session" ? "turn" : undefined,
      activeSessionId: () => "session",
      disposed: () => false
    });
    const waiting: AgentStreamEvent = { phase: "input", text: "", userInput: { id: "question", status: "waiting", blocking: false, questions: [] } };
    const target = { sessionId: "session", turnId: "turn", requestId: "question", kind: "agent" as const };
    controller.observeEvent("session", waiting);
    expect(controller.isWaiting(target)).toBe(true);
    controller.requestFocus(target);
    expect(controller.pendingFocus("session", "other-turn")).toBeUndefined();
    expect(controller.pendingFocus("session", "turn")).toEqual(target);
    expect(controller.pendingFocus("session", "turn")).toBeUndefined();
    controller.clearTurn("session", "turn");
    expect(controller.isWaiting(target)).toBe(false);
    expect(targets).toEqual([]);
  });

  it("does not store secret answers in history", async () => {
    const h = createConversationHarness();
    h.seed([conversation("session")]);
    const process: AgentStreamEvent[] = [{
      phase: "input", text: "", userInput: {
        id: "question", status: "answered", blocking: false,
        questions: [
          { id: "open", header: "Name", question: "Name?", multiSelect: false, options: [], isSecret: false },
          { id: "secret", header: "Token", question: "Token?", multiSelect: false, options: [], isSecret: true }
        ],
        answers: { open: { answers: ["visible"] }, secret: { answers: ["hunter2"] } }
      }
    }];
    await h.history.addSuccess("prompt", process, { kind: "workflow", executions: [] }, "session", "agent", "turn");
    const stored = h.history.list()[0]?.turns[0]?.process[0]?.userInput;
    expect(stored?.answers?.open).toEqual({ answers: ["visible"] });
    expect(stored?.answers?.secret).toBeUndefined();
    expect(JSON.stringify(h.history.list())).not.toContain("hunter2");
  });
});
