import { describe, expect, it, vi } from "vitest";
import type { InputExecutionResponse, PatchResult } from "../src/core/types.js";
import { PatchReviewController } from "../src/features/conversations/host/patchReviewController.js";
import type { ConversationWebviewResponse } from "../src/features/conversations/contracts/protocol.js";

const method = { id: "apply", title: "Apply" } as never;

function response(patch?: PatchResult, args: readonly unknown[] = []): InputExecutionResponse {
  return {
    kind: "workflow",
    executions: [{
      invocation: { kind: "invocation", method: "agent", arguments: args as never, source: "chat" },
      method: { id: "agent", title: "Agent", kind: "command", source: "builtin" },
      durationMs: 1,
      result: { kind: "agent", text: "proposed", ...(patch ? { patch } : {}) }
    }]
  };
}

function controller(apply: (input: unknown) => Promise<{ status: string; summary: string }>) {
  const posted: ConversationWebviewResponse[] = [];
  const applyPatch = vi.fn(apply);
  const reviews = new PatchReviewController({
    post: async (message) => { posted.push(message); },
    applyMethod: () => method,
    applyPatch: applyPatch as never
  });
  return { reviews, posted, applyPatch };
}

const change = { uri: "file:///a.ts", before: "a", after: "b" };

describe("PatchReviewController", () => {
  it("holds only a proposal nobody applied", () => {
    const { reviews } = controller(async () => ({ status: "applied", summary: "" }));
    expect(reviews.hold("turn", response(undefined))).toBe(false);
    expect(reviews.hold("turn", response({ kind: "patch", title: "T", changes: [{ ...change, before: "same", after: "same" }] }))).toBe(false);
    expect(reviews.hold("turn", response({ kind: "patch", title: "T", changes: [change] }, [{ name: "apply", value: true }]))).toBe(false);
    expect(reviews.hold("turn", response({ kind: "patch", title: "T", changes: [change] }, [{ name: "apply", value: false }]))).toBe(true);
    expect(reviews.has("turn")).toBe(true);
  });

  it("applies once and never writes the same proposal twice", async () => {
    const { reviews, posted, applyPatch } = controller(async () => ({ status: "applied", summary: "Wrote a.ts" }));
    reviews.hold("turn", response({ kind: "patch", title: "T", changes: [change] }));
    await reviews.resolve("session", "turn", [], true);
    expect(applyPatch).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toMatchObject({ type: "patchResolved", status: "applied", uris: ["file:///a.ts"] });
    await expect(reviews.resolve("session", "turn", [], true)).rejects.toThrow("no longer available");
    expect(applyPatch).toHaveBeenCalledOnce();
  });

  it("keeps a conflicting proposal pending and reports it", async () => {
    const { reviews, posted } = controller(async () => ({ status: "conflict", summary: "File changed" }));
    reviews.hold("turn", response({ kind: "patch", title: "T", changes: [change] }));
    await reviews.resolve("session", "turn", [], true);
    expect(posted.at(-1)).toMatchObject({ type: "patchResolved", status: "conflict", message: "File changed" });
    expect(reviews.has("turn")).toBe(true);
  });

  it("resolves one file at a time and keeps the rest pending", async () => {
    const { reviews, posted, applyPatch } = controller(async () => ({ status: "applied", summary: "ok" }));
    const second = { uri: "file:///b.ts", before: "c", after: "d" };
    reviews.hold("turn", response({ kind: "patch", title: "T", changes: [change, second] }));
    await reviews.resolve("session", "turn", ["file:///a.ts"], true);
    expect(applyPatch).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toMatchObject({ uris: ["file:///a.ts"] });
    await reviews.resolve("session", "turn", ["file:///b.ts"], true);
    expect(applyPatch).toHaveBeenCalledTimes(2);
    expect(reviews.has("turn")).toBe(false);
  });

  it("discards a rejected proposal without writing anything", async () => {
    const { reviews, posted, applyPatch } = controller(async () => ({ status: "applied", summary: "" }));
    reviews.hold("turn", response({ kind: "patch", title: "T", changes: [change] }));
    await reviews.resolve("session", "turn", [], false);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: "patchResolved", status: "rejected" });
    expect(reviews.has("turn")).toBe(false);
  });
});
