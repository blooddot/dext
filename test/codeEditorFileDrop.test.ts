import { describe, expect, it, vi } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { DextCodeEditor } from "../src/webview/codeEditor.js";
import { inputReferenceProjections } from "../src/webview/fileReferenceDecorations.js";

vi.mock('../src/webview/monacoEnvironment.js', () => ({ monaco: {
  Range: { fromPositions: (from: {column:number}, to: {column:number}) => ({ startColumn:from.column,endColumn:to.column }) },
  editor:{EndOfLineSequence:{LF:0}}
} }));
import { ReferenceProjection } from '../src/webview/monacoReferences.js';
function dropHarness(source: string, selection = 0) {
  const projection = new ReferenceProjection(); let current = projection.encode(source);
  const focus = vi.fn(), toggle=vi.fn();
  const position=(offset:number)=>({lineNumber:1,column:offset+1});
  const getTargetAtClientPoint=vi.fn(()=>({position:position(selection)}));
  const model={getValue:()=>current,setValue:(value:string)=>{current=value;},setEOL:vi.fn(),dispose:vi.fn(),getPositionAt:position,getOffsetAt:(p:{column:number})=>p.column-1};
  const view={getTargetAtClientPoint,dispose:vi.fn(),trigger:vi.fn(),pushUndoStop:vi.fn(),setPosition:vi.fn(),revealPositionInCenterIfOutsideViewport:vi.fn(),getPosition:()=>position(selection),
    getSelection:()=>({getStartPosition:()=>position(selection),getEndPosition:()=>position(selection)}),
    executeEdits:(_source:string,edits:Array<{range:{startColumn:number;endColumn:number};text:string}>)=>{
      for(const edit of edits)current=current.slice(0,edit.range.startColumn-1)+edit.text+current.slice(edit.range.endColumn-1);
    }};
  const editor=Object.create(DextCodeEditor.prototype) as DextCodeEditor;
  Object.assign(editor,{view,model,projection,focus,dropRevision:0,disposables:[],scheduleDiagnostics:vi.fn(),renderReferences:vi.fn(),options:{parent:{classList:{toggle}}}});
  return {editor,focus,toggle,posAtCoords:getTargetAtClientPoint};
}

describe("Monaco file-reference drop", () => {
  function eventHarness(source = "解释代码", selection = 2) {
    const { editor, focus, toggle, posAtCoords } = dropHarness(source, selection);
    const resolveDroppedFiles = vi.fn<(paths: string[]) => Promise<string[]>>()
      .mockResolvedValue(["@src/a.ts", "@src/b.ts"]);
    const onError = vi.fn();
    Object.assign(editor, { options: { parent: { classList: { toggle } }, resolveDroppedFiles, onError } });
    const event = {
      shiftKey: true, clientX: 20, clientY: 30,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      dataTransfer: {
        types: ["text/uri-list"], files: [], dropEffect: "none",
        getData: vi.fn(() => "file:///repo/src/a.ts\r\nfile:///repo/src/b.ts")
      }
    };
    const handlers = editor as unknown as {
      fileDrop(event: unknown): boolean;
      fileDragOver(event: unknown): boolean;
    };
    return { editor, focus, event, handlers, resolveDroppedFiles, onError, toggle, posAtCoords };
  }

  it("accepts a file dragover without Shift and inserts multiple refs at the drop coordinates", async () => {
    const { editor, event, handlers, resolveDroppedFiles, toggle, posAtCoords } = eventHarness();
    expect(handlers.fileDragOver(event)).toBe(true);
    expect(event.dataTransfer.dropEffect).toBe("copy");
    expect(event.dataTransfer.getData).not.toHaveBeenCalled();
    expect(toggle).toHaveBeenLastCalledWith("file-drop-active", true);
    expect(handlers.fileDrop(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(resolveDroppedFiles).toHaveBeenCalledWith(["file:///repo/src/a.ts", "file:///repo/src/b.ts"]);
    await Promise.resolve();
    expect(editor.source).toContain("解释 @src/a.ts @src/b.ts 代码");
    expect(posAtCoords).toHaveBeenCalledWith(20, 30);
    expect(inputReferenceProjections(editor.source)).toHaveLength(2);
    expect(toggle).toHaveBeenLastCalledWith("file-drop-active", false);
  });

  it("leaves ordinary text drags to Monaco", () => {
    const { event, handlers, resolveDroppedFiles } = eventHarness();
    event.shiftKey = false;
    event.dataTransfer.types = ["text/plain"];
    event.dataTransfer.getData.mockReturnValue("ordinary text");
    expect(handlers.fileDrop(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(resolveDroppedFiles).not.toHaveBeenCalled();
  });

  it("does not insert a late result after switching to an identical draft", async () => {
    const { editor, event, handlers, focus } = eventHarness();
    handlers.fileDrop(event);
    editor.setValue(editor.source);
    focus.mockClear();
    await Promise.resolve();
    expect(editor.source).toBe("解释代码");
    expect(focus).not.toHaveBeenCalled();
  });

  it("ignores a late result after the editor is destroyed", async () => {
    const { editor, event, handlers } = eventHarness();
    handlers.fileDrop(event);
    editor.destroy();
    await Promise.resolve();
    expect(editor.source).toBe("解释代码");
  });

  it("reports unresolved files without pasting raw paths", async () => {
    const { editor, event, handlers, resolveDroppedFiles, onError } = eventHarness();
    resolveDroppedFiles.mockRejectedValue(new Error("missing file"));
    handlers.fileDrop(event);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "missing file" }));
    expect(editor.source).toBe("解释代码");
  });

  function expectCompiled(source: string): void {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    expect(compileWorkflow(source, registry).diagnostics).toEqual([]);
  }

  it("inserts at the current selection outside an agent input", () => {
    const source = 'input = """这段代码是什么含义\n"""\nagent(input=input)';
    const cursor = source.indexOf("\n");
    const { editor, focus } = dropHarness(source, cursor);

    editor.insertFileReferences(['@src/pathx.py#L55,1-L66,32']);

    expect(editor.source).toContain('input = """这段代码是什么含义 @src/pathx.py#L55,1-L66,32\n"""');
    expect(editor.source).toContain("agent(input=input)");
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
