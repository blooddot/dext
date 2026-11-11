import { describe, expect, it } from "vitest";
import { NO_STATED_REASON, turnChanges } from "../src/features/conversations/domain/turnDiff.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";
import type { InputExecutionResponse } from "../src/shared/contracts/types.js";

function record(changedFiles?: string[], process: DextHistoryRecord["process"] = [], response?: InputExecutionResponse): DextHistoryRecord {
  return { id: "turn", createdAt: 1, input: "do it", process, output: "", ...(changedFiles ? { changedFiles } : {}), ...(response ? { response } : {}) };
}

function answer(text: string): InputExecutionResponse {
  return { kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "agent", arguments: [{ name: "input", value: "do it" }], source: "chat" },
    method: { id: "agent", title: "Agent", kind: "command", source: "builtin" },
    result: { kind: "agent", text },
    durationMs: 1
  }] };
}

describe("turnChanges", () => {
  it("takes the tool event line that names the whole path", () => {
    const changes = turnChanges(record(["src/app/sidebarProvider.ts"], [
      { phase: "status", text: "src/app/sidebarProvider.ts is unrelated status" },
      { phase: "tool", text: "apply patch to src/features/a.ts\nwrite src/app/sidebarProvider.ts" }
    ]));
    expect(changes).toEqual([{ path: "src/app/sidebarProvider.ts", reason: "write src/app/sidebarProvider.ts" }]);
  });

  it("falls back to the Agent's own sentence naming only the file", () => {
    const changes = turnChanges(record(["src/features/conversations/domain/turnDiff.ts"], [],
      answer("I added the reason column in turnDiff.ts so the diff can label each file.")));
    expect(changes).toEqual([{ path: "src/features/conversations/domain/turnDiff.ts", reason: "I added the reason column in turnDiff.ts so the diff can label each file." }]);
  });

  it("marks a file the turn never mentioned instead of reusing another file's line", () => {
    const changes = turnChanges(record(["src/a.ts", "src/features/b/render.ts"], [
      { phase: "tool", text: "edit src/features/b/render.ts to add the button" }
    ]));
    expect(changes).toEqual([
      { path: "src/a.ts", reason: NO_STATED_REASON },
      { path: "src/features/b/render.ts", reason: "edit src/features/b/render.ts to add the button" }
    ]);
    expect(NO_STATED_REASON).toBe("no stated reason");
  });

  it("returns nothing when the turn recorded no changed files", () => {
    expect(turnChanges(record(undefined, [{ phase: "tool", text: "edit src/a.ts" }]))).toEqual([]);
    expect(turnChanges(record([], [{ phase: "tool", text: "edit src/a.ts" }]))).toEqual([]);
  });

  it("keeps a long command line short", () => {
    const long = `npm run ${"x".repeat(200)} && edit src/a.ts`;
    const [change] = turnChanges(record(["src/a.ts"], [{ phase: "tool", text: long }]));
    expect(change?.reason).toBe(`${long.slice(0, 140)}...`);
  });
});

