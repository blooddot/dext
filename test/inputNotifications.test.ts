import { describe, expect, it, vi } from "vitest";
import { InputNotifications, type InputNotificationTarget } from "../src/inputNotifications.js";

const target: InputNotificationTarget = { sessionId: "background", turnId: "turn", requestId: "question", kind: "agent" };
function harness() {
  const replies: Array<(selected: boolean) => void> = [];
  const notify = vi.fn(() => new Promise<boolean>((resolve) => replies.push(resolve)));
  const open = vi.fn<(target: InputNotificationTarget) => Promise<void>>(async () => {});
  return { notifications: new InputNotifications(notify, open), notify, open, replies };
}

describe("input notifications", () => {
  it("notifies once per request and opens only on the user's action", async () => {
    const h = harness();
    h.notifications.observe(target, true);
    h.notifications.observe(target, true);
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.open).not.toHaveBeenCalled();
    h.replies[0]!(true);
    await Promise.resolve();
    expect(h.open).toHaveBeenCalledWith(target);
  });

  it("keeps sessions, turns and request kinds independent", () => {
    const h = harness();
    for (const next of [target, { ...target, sessionId: "other" }, { ...target, turnId: "next" }, { ...target, kind: "ui" as const }]) {
      h.notifications.observe(next, true);
    }
    expect(h.notify).toHaveBeenCalledTimes(4);
  });

  it.each(["answered", "finished", "disposed", "dismissed"])("ignores stale or %s notification actions", async (reason) => {
    const h = harness();
    h.notifications.observe(target, true);
    if (reason === "answered") {
      h.notifications.observe(target, false);
      h.notifications.observe(target, true);
    }
    if (reason === "finished") h.notifications.clearTurn(target.sessionId, target.turnId);
    if (reason === "disposed") h.notifications.dispose();
    h.replies[0]!(reason !== "dismissed");
    await Promise.resolve();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it("does not notify for terminal requests or revive them from delayed events", () => {
    const h = harness();
    h.notifications.observe(target, false);
    h.notifications.observe(target, true);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("isolates notification failures from the running agent", async () => {
    const open = vi.fn(async () => {});
    const notifications = new InputNotifications(() => { throw new Error("unavailable"); }, open);
    expect(() => notifications.observe(target, true)).not.toThrow();
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });
});
