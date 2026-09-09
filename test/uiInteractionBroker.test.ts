import { describe, expect, it } from "vitest";
import { UiInteractionBroker } from "../src/uiInteractionBroker.js";
import { uiCallForm, type UiInteractionState } from "../src/core/uiForm.js";
const form = uiCallForm("radio", { label: "Pick", options: ["a", "b"] });
const response = { kind: "ui", type: "form", status: "submitted", answers: { answer: { type: "radio", selected: ["b"] } } };
describe("host interaction ownership", () => {
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
