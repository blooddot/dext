import { describe, expect, it } from "vitest";
import { prepareHistoryTrace } from "../src/core/agentTraceReplay.js";

describe("persisted agent trace replay", () => {
  it("keeps non-tool order and folds replacement chunks at the first tool position", () => {
    const events = [
      { phase: "message", id: "m", text: "before" },
      { phase: "tool", id: "cmd", text: "one" },
      { phase: "message", id: "n", text: "between" },
      { phase: "tool", id: "cmd", text: "two" },
      { phase: "tool", id: "other", text: "final", replace: true }
    ] as const;
    expect(prepareHistoryTrace(events)).toEqual([
      events[0],
      { ...events[1], ...events[3], text: "onetwo", replace: true },
      events[2],
      events[4]
    ]);
  });

  it("uses stable ids to merge prose deltas while keeping anonymous messages separate", () => {
    expect(prepareHistoryTrace([
      { phase: "message", id: "m", text: "Hel" },
      { phase: "message", id: "m", text: "lo" },
      { phase: "message", text: "A" },
      { phase: "message", text: "B" }
    ])).toEqual([
      { phase: "message", id: "m", text: "Hello", replace: true },
      { phase: "message", text: "A" },
      { phase: "message", text: "B" }
    ]);
  });
});
