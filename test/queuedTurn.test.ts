import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QueuedTurns } from "../src/features/conversations/browser/queuedTurn.js";

describe("queued turns", () => {
  it("keeps one message per conversation", () => {
    const turns = new QueuedTurns();
    turns.queue("a", { mode: "agent", source: "first" });
    turns.queue("a", { mode: "ask", source: "second" });
    expect(turns.peek("a")).toEqual({ mode: "ask", source: "second" });
    expect(turns.entries()).toHaveLength(1);
  });

  it("only takes the message once its conversation can send", () => {
    const turns = new QueuedTurns();
    turns.queue("a", { mode: "plan", source: "next", planPath: "p.md" });
    expect(turns.take("a", false)).toBeUndefined();
    expect(turns.peek("a")).toEqual({ mode: "plan", source: "next", planPath: "p.md" });
    expect(turns.take("a", true)).toEqual({ mode: "plan", source: "next", planPath: "p.md" });
    expect(turns.take("a", true)).toBeUndefined();
  });

  it("does not send a withdrawn message", () => {
    const turns = new QueuedTurns();
    turns.queue("a", { mode: "agent", source: "oops" });
    turns.delete("a");
    expect(turns.take("a", true)).toBeUndefined();
  });

  it("drops messages of closed conversations", () => {
    const turns = new QueuedTurns();
    turns.queue("a", { mode: "agent", source: "keep" });
    turns.queue("b", { mode: "agent", source: "closed" });
    turns.retain(["a"]);
    expect(turns.entries()).toEqual([["a", { mode: "agent", source: "keep" }]]);
  });

  it("round-trips through the webview state", () => {
    const turns = new QueuedTurns();
    turns.queue("a", { mode: "agent", source: "restored" });
    const restored = new QueuedTurns();
    restored.replace(turns.toRecord());
    expect(restored.peek("a")).toEqual({ mode: "agent", source: "restored" });
    restored.replace({});
    expect(restored.entries()).toEqual([]);
  });

  it("sends a queued message to its own conversation, not the tab on screen", async () => {
    const main = await readFile(resolve("src/webview/main.ts"), "utf8");
    const flush = main.slice(main.indexOf("function flushQueuedTurn"), main.indexOf("function run()"));
    expect(flush).toContain('vscode.postMessage({ type: "executeInput", sessionId, ...turn })');
    expect(flush).not.toContain("browser.activeId");
  });
});
