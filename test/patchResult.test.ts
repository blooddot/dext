import { describe, expect, it } from "vitest";
import { patchResultFrom } from "../src/shared/protocol/patch.js";
import type { PatchResult } from "../src/shared/contracts/types.js";

describe("patchResultFrom", () => {
  it("returns undefined for an AgentResult without a patch", () => {
    expect(patchResultFrom({ kind: "agent", text: "no edits" })).toBeUndefined();
    expect(patchResultFrom({ kind: "agent", text: "no edits", patch: undefined })).toBeUndefined();
  });

  it("rejects a null patch instead of treating it as absent", () => {
    expect(() => patchResultFrom({ kind: "agent", text: "", patch: null }))
      .toThrow("apply requires a valid patch result.");
  });

  it("rejects a result whose kind cannot carry an absent patch", () => {
    expect(() => patchResultFrom({ kind: "ask", text: "question" }))
      .toThrow("apply expects an AgentResult or a result containing a patch; received 'ask'.");
  });

  it("returns a valid patch unchanged", () => {
    const patch: PatchResult = {
      kind: "patch",
      title: "Edit",
      changes: [{ uri: "file:///x.ts", before: "a", after: "b" }]
    };
    expect(patchResultFrom(patch)).toEqual(patch);
    expect(patchResultFrom({ kind: "agent", text: "preview", patch })).toEqual(patch);
  });
});
