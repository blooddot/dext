import { describe, expect, it } from "vitest";
import { CompletionContextQueue } from "../src/core/completionContext.js";
import { CompletionMemory } from "../src/core/completionMemory.js";
describe("bounded background work", () => {
  it("retains occupied slots for unresponsive providers and bounds queued demand", async () => {
    const queue = new CompletionContextQueue(); let calls = 0;
    const stuck = () => { calls++; return new Promise<void>(() => undefined); };
    for (let i = 0; i < 1000; i++) queue.schedule(String(i), stuck);
    await Promise.resolve(); expect(calls).toBe(2); expect(queue.report()).toEqual({ running: 2, queued: 16 });
    queue.schedule("0", stuck); expect(queue.report().running).toBe(2);
    queue.dispose(); expect(queue.report().queued).toBe(0);
  });
  it("does not await a stuck persistent write to read policy state", () => {
    const memory = new CompletionMemory({ get: () => undefined, update: () => new Promise<void>(() => undefined) });
    memory.record("root", "abcdefabcdefabcdefabcdef", "retained"); void memory.flush();
    expect(memory.bucket("root", "abcdefabcdefabcdefabcdef").retained).toBeGreaterThan(0.99); memory.dispose();
  });
});
