import { describe, expect, it } from "vitest";
import { dextBuiltinNames, dextTypesNotice } from "../src/webview/dextTypesStatus.js";

/**
 * Code mode is plain TypeScript: the composer completes imports and their exports the
 * way any TypeScript file does, and nothing translates a `.dx` habit such as
 * `git.commit()` into anything. The only completion this module contributes is the one
 * that says the types are missing — because an editor with no declaration answers every
 * name with a silent "No suggestions.", which looks exactly like a stale Webview.
 */
describe("the composer's types notice", () => {
  it("says nothing once the types are there", () => {
    expect(dextTypesNotice("git", { line: 1, column: 4 }, true)).toBeUndefined();
    expect(dextTypesNotice("commit", { line: 1, column: 7 }, true)).toBeUndefined();
  });

  it("names the problem, and only when something was typed", () => {
    expect(dextTypesNotice("", { line: 1, column: 1 }, false)).toBeUndefined();
    const notice = dextTypesNotice("git", { line: 1, column: 4 }, false)!;
    expect(notice.label).toBe("Dext types not loaded");
    expect(notice.detail).toContain("Reload Window");
    // Filtered by what was typed, so the widget cannot hide it, and accepting it is a
    // no-op rather than an edit the user did not ask for.
    expect(notice.filterText).toBe("git");
    expect(notice.insertText).toBe("git");
    expect(notice.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 });
  });

  it("reads the built-in names out of the generated declaration", () => {
    const declaration = [
      "declare module \"dext\" {",
      "  export interface AskResult {",
      "    kind: \"ask\";",
      "  }",
      "  export function ask(options: { input: string }): Promise<AskResult>;",
      "  export function ui(options: never): Promise<never>;",
      "  export const mcp: { [server: string]: unknown };",
      "}"
    ].join("\n");
    expect(dextBuiltinNames(declaration)).toEqual(["ask", "mcp", "ui"]);
    expect(dextBuiltinNames("declare module \"dext\" { }")).toEqual([]);
  });
});
