import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent, InputExecutionResponse } from "../src/core/types.js";
import { conversation, createConversationHarness, defaultSelection } from "./conversationHarness.js";

function deferred() {
  const releases: Array<(response: InputExecutionResponse) => void> = [];
  const executeConversation = vi.fn(() => new Promise<InputExecutionResponse>((resolve) => { releases.push(resolve); }));
  return {
    executeConversation,
    release: (response: InputExecutionResponse = { kind: "workflow", executions: [] }) => releases.shift()?.(response)
  };
}

describe("TurnExecutionCoordinator", () => {
  it("runs one turn per conversation while another conversation runs concurrently", async () => {
    const execution = deferred();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    h.seed([conversation("a"), conversation("b")]);
    const a = h.controller.session("a")!;
    const b = h.controller.session("b")!;
    const first = h.coordinator.execute(a, "agent", "first");
    await vi.waitFor(() => expect(h.coordinator.running("a")).toBe(true));
    await expect(h.coordinator.execute(a, "agent", "second")).rejects.toThrow("current Dext turn");
    const other = h.coordinator.execute(b, "agent", "another");
    await vi.waitFor(() => expect(execution.executeConversation).toHaveBeenCalledTimes(2));
    execution.release();
    execution.release();
    await Promise.all([first, other]);
    expect(h.executeConversation).toHaveBeenCalledTimes(2);
    expect(h.coordinator.running("a")).toBe(false);
    expect(h.coordinator.running("b")).toBe(false);
    expect(h.history.list(true).find((session) => session.id === "a")?.turns[0]?.input).toBe("first");
    expect(h.history.list(true).find((session) => session.id === "b")?.turns[0]?.input).toBe("another");
  });

  it("keeps the composer selection captured when the turn starts", async () => {
    const execution = deferred();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    h.seed([conversation("a")]);
    h.controller.activate(h.controller.session("a")!);
    h.controller.setSelection("a", { ...defaultSelection, profileId: "codex", model: "first-model" });
    const turn = h.coordinator.execute(h.controller.session("a")!, "agent", "prompt");
    await vi.waitFor(() => expect(execution.executeConversation).toHaveBeenCalledOnce());
    expect(h.coordinator.running("a")).toBe(true);
    h.controller.setSelection("a", { ...defaultSelection, model: "changed-mid-turn" });
    expect(h.controller.selection("a")?.model).toBe("changed-mid-turn");
    execution.release();
    await turn;
    expect(h.controller.selection("a")?.model).toBe("changed-mid-turn");
    // The visible turn used the captured controls, not the late change.
    expect(h.history.list()[0]?.turns[0]?.mode).toBe("agent");
  });

  it("buffers a finished turn's events and never reuses them for the next turn", async () => {
    let events: AgentStreamEvent[][] = [];
    const h = createConversationHarness({
      executeConversation: async (_mode, _source, metadata): Promise<InputExecutionResponse> => {
        metadata.onAgentEvent?.({ phase: "message", id: "m", text: "first" });
        return { kind: "workflow", executions: [] };
      }
    });
    h.seed([conversation("session")]);
    h.controller.activate(h.controller.session("session")!);
    await h.coordinator.execute(h.controller.session("session")!, "agent", "one");
    expect(h.coordinator.active("session")).toBeUndefined();
    await h.coordinator.execute(h.controller.session("session")!, "agent", "two");
    events = h.messages.filter((message) => message.type === "agentEvent").map((message) => [message.event]);
    expect(events.map(([event]) => event?.text)).toEqual(["first", "first"]);
    expect(h.history.list()[0]?.turns[0]?.process.map((event) => event.text)).toEqual(["first"]);
    expect(h.history.list()[0]?.turns[1]?.process.map((event) => event.text)).toEqual(["first"]);
  });

  it("clears the running state and stores the failure when execution throws", async () => {
    const h = createConversationHarness({
      executeConversation: async (): Promise<InputExecutionResponse> => { throw new Error("provider failed"); }
    });
    h.seed([conversation("session")]);
    h.controller.activate(h.controller.session("session")!);
    await h.coordinator.execute(h.controller.session("session")!, "agent", "prompt");
    expect(h.coordinator.running("session")).toBe(false);
    const turn = h.history.list()[0]?.turns[0];
    expect(turn?.error).toBe("provider failed");
    expect(turn?.mode).toBe("agent");
  });

  it("stops at the user's request without starting a continuation round", async () => {
    const h = createConversationHarness({
      executeConversation: async (_mode, _source, metadata): Promise<InputExecutionResponse> => {
        h.coordinator.abort(metadata.agentSessionId!);
        throw new Error("Stopped by user.");
      }
    });
    h.seed([{ ...conversation("session"), planStatus: "active", activePlanPath: "p.plan.md" }]);
    h.controller.activate(h.controller.session("session")!);
    await h.coordinator.execute(h.controller.session("session")!, "plan", "## Tasks\n1. [ ] Work", {
      planPath: "p.plan.md",
      executePlan: true
    });
    expect(h.executeConversation).toHaveBeenCalledOnce();
    const turn = h.history.list()[0]?.turns[0];
    expect(turn?.planOutcome?.status).toBe("cancelled");
    expect(h.controller.session("session")?.planStatus).toBe("active");
  });

  it("replays the calls of a failed Code turn only when it was not stopped", async () => {
    const continuation = [{ method: "ask", args: {} }] as never;
    const executeInput = vi.fn(async (_source: string, _metadata, run: { onCallLog?: (entries: never) => void }): Promise<InputExecutionResponse> => {
      run.onCallLog?.(continuation);
      throw new Error("step failed");
    });
    const h = createConversationHarness({ executeInput });
    h.seed([conversation("session")]);
    h.controller.activate(h.controller.session("session")!);
    await h.coordinator.execute(h.controller.session("session")!, "code", "ask()");
    expect(h.coordinator.takeContinuation("session", h.history.list()[0]!.turns[0]!.id)).toBe(continuation);
    expect(h.coordinator.takeContinuation("session", h.history.list()[0]!.turns[0]!.id)).toBeUndefined();

    const stopped = createConversationHarness({
      executeInput: async (_source, _metadata, run): Promise<InputExecutionResponse> => {
        run.onCallLog?.(continuation);
        stopped.coordinator.abort("session");
        throw new Error("stopped");
      }
    });
    stopped.seed([conversation("session")]);
    stopped.controller.activate(stopped.controller.session("session")!);
    await stopped.coordinator.execute(stopped.controller.session("session")!, "code", "ask()");
    expect(stopped.coordinator.takeContinuation("session", stopped.history.list()[0]!.turns[0]!.id)).toBeUndefined();
  });

  it("holds a read-only Agent proposal for review and skips applied writes", async () => {
    const h = createConversationHarness({
      executeConversation: async (): Promise<InputExecutionResponse> => ({
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "agent", arguments: [{ name: "apply", value: false }], source: "chat" },
          method: { id: "agent", title: "Agent", kind: "command", source: "builtin" }, durationMs: 1,
          result: {
            kind: "agent", text: "proposed",
            patch: { kind: "patch", title: "Change", changes: [{ uri: "file:///a.ts", before: "a", after: "b" }] }
          }
        }]
      })
    });
    h.seed([conversation("session")]);
    h.controller.activate(h.controller.session("session")!);
    await h.coordinator.execute(h.controller.session("session")!, "agent", "edit");
    const turnId = h.history.list()[0]!.turns[0]!.id;
    expect(h.patches.has(turnId)).toBe(true);
    expect(h.messages).toContainEqual(expect.objectContaining({ type: "execution", turnId, reviewPatch: true }));
  });
});
