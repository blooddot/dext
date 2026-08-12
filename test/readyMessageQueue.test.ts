import { describe, expect, it } from "vitest";
import { ReadyMessageQueue } from "../src/readyMessageQueue.js";

describe("ReadyMessageQueue", () => {
  it("retains first-invocation messages until the Webview reports ready", () => {
    const queue = new ReadyMessageQueue<string>();

    expect(queue.enqueue("triggerSuggest")).toBe(true);
    expect(queue.enqueue("triggerParameterHints")).toBe(true);
    expect(queue.markReady()).toEqual(["triggerSuggest", "triggerParameterHints"]);
    expect(queue.enqueue("focusEditor")).toBe(false);
  });

  it("keeps queued messages across a view reset and clears them on disposal", () => {
    const queue = new ReadyMessageQueue<string>();
    queue.enqueue("showChat");
    queue.markNotReady();
    expect(queue.markReady()).toEqual(["showChat"]);
    queue.enqueue("delivered-directly");
    queue.clear();
    expect(queue.isReady).toBe(false);
    expect(queue.markReady()).toEqual([]);
  });
});
