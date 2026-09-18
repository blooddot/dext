import { describe, expect, it, vi } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { DextCodeEditor } from "../src/webview/codeEditor.js";
import { inputReferenceProjections } from "../src/webview/fileReferenceDecorations.js";

interface EditorChange {
  from: number;
  to: number;
  insert: string;
}

function dropHarness(source: string): { editor: DextCodeEditor; focus: ReturnType<typeof vi.fn> } {
  let current = source;
  const focus = vi.fn();
  const document = {
    get length() { return current.length; },
    toString: () => current
  };
  const view = {
    state: {
      selection: { main: { from: 0, to: 0 } },
      doc: document
    },
    dispatch(spec: unknown) {
      const change = (spec as { changes: EditorChange }).changes;
      current = `${current.slice(0, change.from)}${change.insert}${current.slice(change.to)}`;
    }
  };
  const editor = Object.create(DextCodeEditor.prototype) as DextCodeEditor;
  Object.defineProperties(editor, {
    view: { value: view },
    focus: { value: focus }
  });
  return { editor, focus };
}

describe("CodeMirror file-reference drop", () => {
  function expectCompiled(source: string): void {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    expect(compileWorkflow(source, registry).diagnostics).toEqual([]);
  }

  it("converts a normal agent input when the drop has fallen back to an unrelated selection", () => {
    const { editor, focus } = dropHarness('agent(input="这段代码是什么含义")');

    editor.insertFileReferences(['@src/pathx.py#L55,1-L66,32']);

    expect(editor.source).toMatch(/^agent\(input="这段代码是什么含义/);
    expectCompiled(editor.source);
    expect(editor.source).not.toContain('f"');
    expect(editor.source).not.toContain('ref.file(');
    const [projection] = inputReferenceProjections(editor.source);
    expect(projection?.reference.payload).toBe("src/pathx.py#L55,1-L66,32");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("replaces the complete input literal when a drop lands inside Chinese prompt text", () => {
    const source = 'agent(input="这段代码是什么含义，请解释其中逻辑")';
    const { editor } = dropHarness(source);
    const position = source.indexOf("请解释");

    editor.insertFileReferences(['@src/pathx.py#L55,1-L66,32'], position);

    expect(editor.source).toMatch(/^agent\(input="这段代码是什么含义，/);
    expect(editor.source).not.toContain('f"');
    expect(editor.source).not.toContain("ref.file(");
    expectCompiled(editor.source);
  });
});
