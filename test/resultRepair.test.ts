import { describe, expect, it, vi } from "vitest";
import { AxAdapter, REPAIR_OUTPUT_FIELD } from "../src/core/axAdapter.js";
import { createResultRepair, type ResultRepairRequest } from "../src/core/resultRepair.js";
import type { AgentAssertionSnapshot } from "../src/core/agentAssertions.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import type { AgentResult } from "../src/core/types.js";

const contract = new AxAdapter().compile(BUILTIN_METHODS.find((method) => method.id === "agent")!);

function snapshot(options: { apply?: boolean; contents?: Record<string, string>; resolve?: (uri: string) => string | undefined } = {}): AgentAssertionSnapshot {
  const contents = options.contents ?? {};
  return {
    apply: options.apply ?? false,
    resolve: options.resolve ?? ((uri) => uri.startsWith("file:///workspace/") ? uri.slice("file:///workspace/".length) : undefined),
    read: (path) => contents[path],
    isIgnored: () => false
  };
}

function request(raw: string, overrides: Partial<ResultRepairRequest> = {}): ResultRepairRequest {
  return {
    raw,
    diagnostics: "text: invalid",
    snapshot: snapshot(),
    includePatch: true,
    ...overrides
  };
}

function agentResult(text: string, change?: { before: string; after: string; contentHash?: string }): string {
  return JSON.stringify({
    kind: "agent",
    text,
    ...(change
      ? { patch: { kind: "patch", title: "Edit", changes: [{ uri: "file:///workspace/src/a.ts", ...change }] } }
      : {})
  });
}

describe("result repair predictor", () => {
  it("returns a valid result with a single CLI call", async () => {
    const transport = vi.fn(async () => ({ text: agentResult("done") }));
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request(agentResult("done")));
    expect(outcome.result).toMatchObject({ kind: "agent", text: "done" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first response is not parseable and then succeeds", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ text: "not json at all" })
      .mockResolvedValueOnce({ text: agentResult("repaired") });
    const events: { calls: number }[] = [];
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("broken", { onEvent: (event) => events.push({ calls: event.calls }) }));
    expect(outcome.result).toMatchObject({ kind: "agent", text: "repaired" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ calls: 2 }]);
  });

  it("stops after one call when a hard assertion fails (outside workspace)", async () => {
    const transport = vi.fn(async () => ({ text: JSON.stringify({
      kind: "agent",
      text: "edit",
      patch: { kind: "patch", title: "Edit", changes: [{ uri: "file:///elsewhere/a.ts", before: "old", after: "new" }] }
    }) }));
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport }).repair(request("raw"));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeUndefined();
    expect(outcome.diagnostics).toContain("outside the current workspace");
  });

  it("hard-fails a stale before without spending a retry", async () => {
    const transport = vi.fn(async () => ({ text: agentResult("edit", { before: "stale", after: "new" }) }));
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("raw", { snapshot: snapshot({ contents: { "src/a.ts": "current" } }) }));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(outcome.diagnostics).toContain("changed after the edit preview");
  });

  it("hard-fails a stale contentHash and names the edit preview", async () => {
    const transport = vi.fn(async () => ({ text: agentResult("edit", { before: "current", after: "new", contentHash: "deadbeef" }) }));
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("raw", { snapshot: snapshot({ contents: { "src/a.ts": "current" } }) }));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(outcome.diagnostics).toContain("no longer matches the edit preview");
  });

  it("retries once for a soft assertion and accepts the fixed result", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ text: agentResult("no-op", { before: "same", after: "same" }) })
      .mockResolvedValueOnce({ text: agentResult("fixed", { before: "same", after: "changed" }) });
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("raw", { snapshot: snapshot({ contents: { "src/a.ts": "same" } }) }));
    expect(outcome.result).toMatchObject({ kind: "agent", text: "fixed" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rethrows an aborted run instead of converting it into diagnostics", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const transport = vi.fn(async () => ({ text: agentResult("done") }));
    await expect(createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("raw", { signal: controller.signal }))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns the repaired result as a typed DextResult", async () => {
    const transport = vi.fn(async () => ({ text: agentResult("typed") }));
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport }).repair(request("raw"));
    const result = outcome.result as AgentResult;
    expect(result.kind).toBe("agent");
    expect(result.text).toBe("typed");
  });

  it("enforces agent(patch=false) on a repaired result and says so in the prompt", async () => {
    const prompts: string[] = [];
    const transport = vi.fn(async (prompt: string) => { prompts.push(prompt); return { text: agentResult("preview", { before: "a", after: "b" }) }; });
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("raw", { includePatch: false, snapshot: snapshot({ contents: { "src/a.ts": "a" } }) }));
    // The schema allows a patch, so the contract has to be stated and then applied.
    expect(prompts.join("\n")).toContain("Do not include a patch");
    expect(outcome.result).toMatchObject({ kind: "agent", text: "preview" });
    expect(outcome.result).not.toHaveProperty("patch");
  });

  it("keeps a patch when the caller asked for one", async () => {
    const transport = vi.fn(async () => ({ text: agentResult("edit", { before: "a", after: "b" }) }));
    const outcome = await createResultRepair({ contract, outputField: REPAIR_OUTPUT_FIELD, transport })
      .repair(request("raw", { includePatch: true, snapshot: snapshot({ contents: { "src/a.ts": "a" } }) }));
    expect((outcome.result as AgentResult).patch).toMatchObject({ kind: "patch" });
  });
});
