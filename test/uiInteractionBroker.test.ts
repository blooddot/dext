import { describe, expect, it } from "vitest";
import { UiInteractionBroker } from "../src/uiInteractionBroker.js";
import { parseUiForm, uiCallForm, type UiInteractionState } from "../src/core/uiForm.js";
const form = uiCallForm("radio", { label: "Pick", options: ["a", "b"] });
const response = { kind: "ui", type: "form", status: "submitted", answers: { answer: { type: "radio", selected: ["b"] } } };
describe("host interaction ownership", () => {
  it("enforces the submitted action's requirements and keeps invalid responses pending", async () => {
    const broker = new UiInteractionBroker();
    const definition = parseUiForm({ title: "Review", fields: [
      { id: "feedback", type: "input", label: "Feedback", required: false, multiline: true }
    ], actions: [
      { id: "revise", label: "Revise", requires: ["feedback"] },
      { id: "approve", label: "Approve", primary: true }
    ] });
    const submitted = { kind: "ui", type: "form", status: "submitted", answers: {} };
    const states: UiInteractionState[] = [];
    const pending = broker.request("a", "t", definition, undefined, (state) => states.push(state), "r");
    for (const invalid of [submitted, { ...submitted, action: "unknown" }, { ...submitted, action: "revise" },
      { ...submitted, action: "revise", answers: { feedback: { type: "input", value: " \n " } } }]) {
      expect(broker.respond("a", "t", "r", invalid)).toBe(false);
      expect(states.map((state) => state.status)).toEqual(["waiting"]);
    }
    const revised = { ...submitted, action: "revise", answers: { feedback: { type: "input", value: "More context" } } };
    expect(broker.respond("a", "t", "r", revised)).toBe(true);
    await expect(pending).resolves.toEqual(revised);
    expect(states.at(-1)).toMatchObject({ status: "submitted", action: "revise", answers: revised.answers });
    const approval = broker.request("a", "t", definition, undefined, undefined, "approve");
    expect(broker.respond("a", "t", "approve", { ...submitted, action: "approve" })).toBe(true);
    await expect(approval).resolves.toEqual({ ...submitted, action: "approve" });
  });
  it("applies the only action's requirements to legacy responses without an action", async () => {
    const broker = new UiInteractionBroker();
    const definition = parseUiForm({ title: "Review", fields: [
      { id: "feedback", type: "input", label: "Feedback", required: false }
    ], actions: [{ id: "revise", label: "Revise", requires: ["feedback"] }] });
    const submitted = { kind: "ui", type: "form", status: "submitted", answers: {} };
    const pending = broker.request("a", "t", definition, undefined, undefined, "r");
    expect(broker.respond("a", "t", "r", submitted)).toBe(false);
    const revised = { ...submitted, answers: { feedback: { type: "input", value: "More context" } } };
    expect(broker.respond("a", "t", "r", revised)).toBe(true);
    await expect(pending).resolves.toEqual(revised);
  });
  it("cleans up when the initial state cannot be published", async () => {
    const broker = new UiInteractionBroker();
    await expect(broker.request("a", "t", form, undefined, () => { throw new Error("Publish failed"); }, "r")).rejects.toThrow("Publish failed");
    expect(broker.respond("a", "t", "r", response)).toBe(false);
    const retry = broker.request("a", "t", form, undefined, undefined, "r");
    expect(broker.respond("a", "t", "r", response)).toBe(true);
    await expect(retry).resolves.toEqual(response);
  });
  it("settles responses and all aborted waits even if terminal publishing fails", async () => {
    const broker = new UiInteractionBroker();
    const publish = (state: UiInteractionState): void => { if (state.status !== "waiting") throw new Error("Publish failed"); };
    const submitted = broker.request("a", "t", form, undefined, publish, "r");
    const failed = expect(submitted).rejects.toThrow("Publish failed");
    expect(broker.respond("a", "t", "r", response)).toBe(true);
    await failed;
    expect(broker.respond("a", "t", "r", response)).toBe(false);
    const controller = new AbortController();
    const aborted = expect(broker.request("a", "t", form, controller.signal, publish)).rejects.toThrow("cancelled");
    controller.abort(); await aborted;
    const first = expect(broker.request("a", "t", form, undefined, publish)).rejects.toThrow("cancelled");
    const second = expect(broker.request("b", "t", form, undefined, publish)).rejects.toThrow("cancelled");
    broker.dispose(); await Promise.all([first, second]);
  });
  it("isolates concurrent requests even when request IDs match", async () => {
    const broker = new UiInteractionBroker();
    const first = broker.request("a", "turn", form, undefined, undefined, "request");
    const second = broker.request("b", "turn", form, undefined, undefined, "request");
    expect(broker.respond("a", "old", "request", response)).toBe(false);
    expect(broker.respond("a", "turn", "request", { ...response, answers: { answer: { type: "radio", selected: ["unknown"] } } })).toBe(false);
    expect(broker.respond("a", "turn", "request", response)).toBe(true);
    expect(await first).toEqual(response);
    expect(broker.respond("a", "turn", "request", response)).toBe(false);
    expect(broker.respond("b", "turn", "request", response)).toBe(true);
    expect(await second).toEqual(response);
  });
  it("publishes terminal states and aborts without returning ordinary cancellation", async () => {
    const broker = new UiInteractionBroker(); const controller = new AbortController();
    const states: UiInteractionState[] = [];
    const pending = broker.request("a", "t", form, controller.signal, (state) => states.push(state));
    const rejected = expect(pending).rejects.toThrow("cancelled"); controller.abort(); await rejected;
    expect(states.map((state) => state.status)).toEqual(["waiting", "closed"]);
    expect(broker.respond("a", "t", states[0]!.requestId, response)).toBe(false);
    await expect(broker.request("a", "t", form, controller.signal)).rejects.toThrow("cancelled");
    const remaining = broker.request("a", "t", form);
    const disposed = expect(remaining).rejects.toThrow("cancelled"); broker.dispose(); await disposed;
  });
  it("validates cancellation and clears waiting exactly once", async () => {
    const broker = new UiInteractionBroker(); const states: UiInteractionState[] = [];
    const pending = broker.request("a", "t", form, undefined, (state) => states.push(state), "r");
    expect(broker.respond("a", "t", "r", { ...response, status: "cancelled" })).toBe(false);
    const cancelled = { ...response, status: "cancelled", answers: {} };
    expect(broker.respond("a", "t", "r", cancelled)).toBe(true);
    expect(await pending).toEqual(cancelled);
    broker.dispose(); expect(states.map((state) => state.status)).toEqual(["waiting", "cancelled"]);
  });
});
