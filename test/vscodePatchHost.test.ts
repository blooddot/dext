import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchResult, ResolvedInvocation } from "../src/core/types.js";
import type { DeterministicHandler } from "../src/core/runtime.js";

const vscodeState = vi.hoisted(() => ({
  trusted: true,
  text: "before",
  applyResult: true
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
  replacements: { text: string }[] = [];
  replace(_: unknown, __: unknown, text: string): void { this.replacements.push({ text }); }
}

const uri = { scheme: "file", fsPath: "C:\\workspace\\x.ts", toString: () => "file:///C:/workspace/x.ts" };
const document = {
  uri,
  version: 1,
  getText: () => vscodeState.text,
  save: async () => true,
  positionAt: (offset: number) => new Position(0, offset),
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
      if (vscodeState.applyResult && edit.replacements[0]) vscodeState.text = edit.replacements[0].text;
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

describe("VS Code patch host", () => {
  beforeAll(async () => { ({ applyPatchHandler } = await import("../src/vscodePatchHost.js")); });
  beforeEach(() => {
    vscodeState.trusted = true;
    vscodeState.text = "before";
    vscodeState.applyResult = true;
  });

  it("applies a validated preview through one WorkspaceEdit", async () => {
    const result = await applyPatchHandler(invocation("before", "after"));
    expect(result).toMatchObject({ kind: "apply", status: "applied", summary: "Applied 1 change to 1 file." });
    expect(vscodeState.text).toBe("after");
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
});
