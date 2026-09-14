import { describe, expect, it } from "vitest";
import { replayableHistoryEvents } from "../src/core/agentTraceReplay.js";

describe("persisted agent trace replay", () => {
  it("keeps non-tool order and folds replacement chunks at the first tool position", () => {
    const events = [
      { phase: "message", id: "m", text: "before" },
      { phase: "tool", id: "cmd", text: "one" },
      { phase: "message", id: "n", text: "between" },
      { phase: "tool", id: "cmd", text: "two" },
      { phase: "tool", id: "other", text: "final", replace: true }
    ] as const;
    expect(replayableHistoryEvents(events)).toEqual([
      events[0],
      { ...events[1], ...events[3], text: "onetwo", replace: true },
      events[2],
      events[4]
    ]);
  });
});
