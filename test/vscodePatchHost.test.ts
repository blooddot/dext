import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, PatchResult, ResolvedInvocation } from "../src/shared/contracts/types.js";
import { DextRuntime, type DeterministicHandler } from "../src/features/workflow/host/runtime.js";
import { MethodRegistry } from "../src/features/workflow/domain/registry.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { ContextResolver } from "../src/features/workflow/host/contextResolver.js";
import type { AgentExecutionRequest } from "../src/features/agents/host/agentRunner.js";

const vscodeState = vi.hoisted(() => ({
  trusted: true,
  text: "before",
  applyResult: true,
  saveResult: true,
  writes: 0
}));

class Position {
  constructor(readonly line: number, readonly character: number) {}
}

class Range {
  start: Position;
  end: Position;
  constructor(start: Position | number, startCharacter: number, endLine?: number, endCharacter?: number) {
    if (start instanceof Position) {
      this.start = start;
      this.end = startCharacter as unknown as Position;
    } else {
      this.start = new Position(start, startCharacter);
      this.end = new Position(endLine!, endCharacter!);
    }
  }
  isEqual(other: Range): boolean {
    return this.start.line === other.start.line && this.start.character === other.start.character
      && this.end.line === other.end.line && this.end.character === other.end.character;
  }
}

class WorkspaceEdit {
  replacements: { range: Range; text: string }[] = [];
  replace(_: unknown, range: Range, text: string): void { this.replacements.push({ range, text }); }
}

const uri = { scheme: "file", fsPath: "C:\\workspace\\x.ts", toString: () => "file:///C:/workspace/x.ts" };
const document = {
  uri,
  version: 1,
  getText: (range?: Range) => range ? vscodeState.text.slice(range.start.character, range.end.character) : vscodeState.text,
  save: async () => vscodeState.saveResult,
  positionAt: (offset: number) => new Position(0, offset),
  offsetAt: (position: Position) => position.character,
  validateRange: (range: Range) => range
};

vi.mock("vscode", () => ({
  Position,
  Range,
  WorkspaceEdit,
  Uri: { parse: () => uri },
  workspace: {
    get isTrusted() { return vscodeState.trusted; },
    getWorkspaceFolder: () => ({ uri }),
    openTextDocument: async () => document,
    applyEdit: async (edit: WorkspaceEdit) => {
      if (vscodeState.applyResult) {
        for (const { range, text } of edit.replacements) {
          vscodeState.text = vscodeState.text.slice(0, range.start.character) + text + vscodeState.text.slice(range.end.character);
          vscodeState.writes++;
          document.version++;
        }
      }
      return vscodeState.applyResult;
    }
  }
}));

let applyPatchHandler: DeterministicHandler;

function invocation(before: string, after: string): ResolvedInvocation {
  return {
    invocation: { kind: "invocation", method: "apply", arguments: [], source: "code" },
    method: {
      id: "apply", title: "Apply", description: "Apply", kind: "command", version: "1",
      input: [], output: { kind: "apply" }, executor: { kind: "deterministic", handler: "applyPatch" }, source: "builtin"
    },
    arguments: {
      result: {
        kind: "patch",
        title: "Patch",
        changes: [{
          uri: uri.toString(),
          before,
          after,
          documentVersion: 1,
          contentHash: createHash("sha256").update(before).digest("hex")
        }]
      } as PatchResult
    },
    context: [],
    metadata: {}
  };
}

function invocationWithoutPatch(): ResolvedInvocation {
  return {
    ...invocation("before", "after"),
    arguments: { result: { kind: "agent", text: "no edits" } }
  };
}

describe("VS Code patch host", () => {
  beforeAll(async () => { ({ applyPatchHandler } = await import("../src/platform/vscode/patchHost.js")); });
  beforeEach(() => {
    vscodeState.trusted = true;
    vscodeState.text = "before";
    vscodeState.applyResult = true;
    vscodeState.saveResult = true;
    vscodeState.writes = 0;
    document.version = 1;
  });

  it("applies a validated preview through one WorkspaceEdit", async () => {
    const result = await applyPatchHandler(invocation("before", "after"));
    expect(result).toMatchObject({ kind: "apply", status: "applied", summary: "Applied 1 change to 1 file." });
    expect(vscodeState.text).toBe("after");
  });

  it("returns unchanged without writing when an AgentResult has no patch", async () => {
    const result = await applyPatchHandler(invocationWithoutPatch());
    expect(result).toMatchObject({ kind: "apply", status: "unchanged", files: [] });
    expect(vscodeState.text).toBe("before");
  });

  it("returns a conflict instead of overwriting content changed after preview", async () => {
    vscodeState.text = "newer";
    const result = await applyPatchHandler(invocation("before", "after"));
    expect(result).toMatchObject({ kind: "apply", status: "conflict" });
    expect(vscodeState.text).toBe("newer");
  });

  it("requires workspace trust", async () => {
    vscodeState.trusted = false;
    await expect(applyPatchHandler(invocation("before", "after"))).rejects.toThrow("trusted workspace");
  });

  function runtimeFor(result: AgentResult, provider: "codex" | "claude" | "deepseek-harness" = "codex", writeDirectly = false) {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const resolver = new ContextResolver({
      selection: async () => undefined, activeFile: async () => undefined,
      file: async () => undefined, symbol: async () => undefined, dir: async () => undefined
    });
    const runtime = new DextRuntime(registry, resolver, undefined, { applyPatch: applyPatchHandler });
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: provider, label: provider, provider, command: provider, models: [] }]);
    runtime.setAgentSelection({ profileId: provider });
    const run = vi.fn(async (request: AgentExecutionRequest) => {
      if (writeDirectly) {
        expect(request.allowWorkspaceWrite).toBe(true);
        vscodeState.text = "after";
        vscodeState.writes++;
      }
      return result;
    });
    runtime.setAgentRunner({ run });
    return { runtime, run };
  }

  const agentInvocation = (apply = false) => ({
    kind: "invocation" as const, method: "agent", source: "code" as const,
    arguments: [{ name: "input", value: "edit" }, { name: "apply", value: apply }, { name: "patch", value: true }]
  });
  const agentResult = (): AgentResult => ({ kind: "agent", text: "Done", patch: invocation("before", "after").arguments.result as PatchResult });

  it.each(["codex", "claude", "deepseek-harness"] as const)("automatically applies %s patches before returning and consumes them", async (provider) => {
    const { runtime, run } = runtimeFor(agentResult(), provider);
    const response = await runtime.execute(agentInvocation());
    expect(run.mock.calls[0]?.[0].allowWorkspaceWrite).toBe(false);
    expect(vscodeState.text).toBe("after");
    expect(response.patchApplication).toMatchObject({ status: "applied" });
    expect(response.result).not.toHaveProperty("patch");
    expect((response.result as AgentResult).summary).toContain("Auto-apply applied");
    const repeated = await runtime.execute({ kind: "invocation", method: "apply", source: "code", arguments: [{ name: "result", value: response.result }] });
    expect(repeated.result).toMatchObject({ status: "unchanged" });
    expect(vscodeState.writes).toBe(1);
  });

  it("preserves direct-write Agent behavior without applying the edit twice", async () => {
    const { runtime } = runtimeFor(agentResult(), "codex", true);
    const response = await runtime.execute(agentInvocation(true));
    expect(response.patchApplication).toMatchObject({ status: "unchanged", summary: expect.stringContaining("already present") });
    expect(vscodeState.text).toBe("after");
    expect(vscodeState.writes).toBe(1);
  });

  it("does not repeat an insertion whose before range is empty", async () => {
    const result = agentResult();
    result.patch!.changes = [{ uri: uri.toString(), before: "", after: "prefix ", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    const { runtime } = runtimeFor(result);
    const response = await runtime.execute(agentInvocation());
    expect(vscodeState.text).toBe("prefix before");
    const repeated = await runtime.execute({ kind: "invocation", method: "apply", source: "code", arguments: [{ name: "result", value: response.result }] });
    expect(repeated.result).toMatchObject({ status: "unchanged" });
    expect(vscodeState.writes).toBe(1);
  });

  it.each(["conflict", "unchanged", "save failure", "edit refusal"])("reports the real auto-apply outcome: %s", async (scenario) => {
    const result = agentResult();
    if (scenario === "conflict") vscodeState.text = "newer";
    if (scenario === "unchanged") result.patch!.changes = [];
    if (scenario === "save failure") vscodeState.saveResult = false;
    if (scenario === "edit refusal") vscodeState.applyResult = false;
    const { runtime } = runtimeFor(result);
    const response = await runtime.execute(agentInvocation());
    expect(response.patchApplication?.status).toBe(scenario === "unchanged" ? "unchanged" : "conflict");
    expect((response.result as AgentResult).summary).toContain(response.patchApplication!.summary);
    expect(response.result).not.toHaveProperty("patch");
    if (scenario === "conflict") expect(vscodeState.text).toBe("newer");
    if (scenario === "save failure") expect(response.patchApplication?.summary).toContain("could not be saved");
  });

  it("keeps explicit apply behavior: a repeated original patch conflicts without writing", async () => {
    const call = invocation("before", "after");
    expect(await applyPatchHandler(call)).toMatchObject({ status: "applied" });
    expect(await applyPatchHandler(call)).toMatchObject({ status: "conflict" });
    expect(vscodeState.writes).toBe(1);
  });

  it("does not mistake a mismatched ranged deletion for an already-written change", async () => {
    const result = agentResult();
    result.patch!.changes = [{ uri: uri.toString(), before: "before", after: "", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }];
    vscodeState.text = "newer";
    const { runtime } = runtimeFor(result);
    const response = await runtime.execute(agentInvocation(true));
    expect(response.patchApplication).toMatchObject({ status: "conflict" });
    expect(vscodeState.text).toBe("newer");
    expect(vscodeState.writes).toBe(0);
  });

  it("automatically applies a patch returned by a writable Agent that has not written it", async () => {
    const { runtime } = runtimeFor(agentResult());
    const response = await runtime.execute(agentInvocation(true));
    expect(response.patchApplication).toMatchObject({ status: "applied" });
    expect(vscodeState.text).toBe("after");
    expect(vscodeState.writes).toBe(1);
  });
});
