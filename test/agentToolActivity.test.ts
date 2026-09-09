import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTimeout } from "../src/core/agentTimeout.js";
import { trackCliToolActivity } from "../src/core/agentToolActivity.js";

afterEach(() => { vi.useRealTimers(); });

describe("CLI tool lifecycle for timeouts", () => {
  it.each(["command_execution", "mcp_tool_call", "dynamic_tool_call"])("tracks Codex %s even when its result has no display text", (type) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 0, 1000);
    trackCliToolActivity("codex", JSON.stringify({ type: "item.started", item: { id: "one", type } }), timeout);
    vi.advanceTimersByTime(5000);
    expect(controller.signal.aborted).toBe(false);
    trackCliToolActivity("codex", JSON.stringify({ type: "item.completed", item: { id: "one", type, aggregated_output: "", status: "failed" } }), timeout);
    vi.advanceTimersByTime(1000);
    expect(controller.signal.aborted).toBe(true);
  });

  it("tracks every Claude call and result, including duplicate streamed starts", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 0, 1000);
    const feed = (value: unknown) => trackCliToolActivity("claude", JSON.stringify(value), timeout);
    feed({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "a", name: "Bash" } } });
    feed({ type: "assistant", message: { content: [
      { type: "tool_use", id: "a", name: "Bash" }, { type: "tool_use", id: "b", name: "Bash" }
    ] } });
    vi.advanceTimersByTime(5000);
    feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "" }] } });
    vi.advanceTimersByTime(5000);
    expect(controller.signal.aborted).toBe(false);
    feed({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "a", content: "" }, { type: "tool_result", tool_use_id: "b", content: "", is_error: true }
    ] } });
    vi.advanceTimersByTime(1000);
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not mistake reasoning, malformed data or unidentified tools for execution", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 0, 1000);
    for (const value of [
      { type: "item.started", item: { id: "one", type: "reasoning" } },
      { type: "item.started", item: { type: "command_execution" } }
    ]) trackCliToolActivity("codex", JSON.stringify(value), timeout);
    trackCliToolActivity("codex", "not json", timeout);
    vi.advanceTimersByTime(1000);
    expect(controller.signal.aborted).toBe(true);
  });
});
