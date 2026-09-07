import type * as VSCode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  workspace: true,
  focused: true,
  editor: undefined as VSCode.TextEditor | undefined,
  selectionChanged: undefined as ((event: Partial<VSCode.TextEditorSelectionChangeEvent>) => void) | undefined,
  configurationChanged: undefined as ((event: Partial<VSCode.ConfigurationChangeEvent>) => void) | undefined,
  activeChanged: undefined as (() => void) | undefined,
  windowChanged: undefined as (() => void) | undefined,
  documentChanged: undefined as ((event: Partial<VSCode.TextDocumentChangeEvent>) => void) | undefined,
  document: undefined as VSCode.TextDocument | undefined,
  disposed: vi.fn(),
  registered: vi.fn(),
  codeLensRegistered: vi.fn(),
  execute: vi.fn<(...args: unknown[]) => Promise<unknown>>()
}));

vi.mock("vscode", () => {
  class Position {
    constructor(readonly line: number, readonly character: number) {}
    isEqual(other: Position) { return this.line === other.line && this.character === other.character; }
  }
  class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(start: number | Position, end: number | Position, endLine?: number, endCharacter?: number) {
      this.start = typeof start === "number" ? new Position(start, end as number) : start;
      this.end = typeof end === "number" ? new Position(endLine!, endCharacter!) : end;
    }
    contains(p: Position) {
      return (p.line > this.start.line || p.line === this.start.line && p.character >= this.start.character)
        && (p.line < this.end.line || p.line === this.end.line && p.character <= this.end.character);
    }
  }
  class Selection extends Range {
    readonly active: Position;
    readonly anchor: Position;
    constructor(anchorLine: number, anchorChar: number, activeLine: number, activeChar: number) {
      const anchor = new Position(anchorLine, anchorChar);
      const active = new Position(activeLine, activeChar);
      const reversed = anchorLine > activeLine || anchorLine === activeLine && anchorChar > activeChar;
      super(reversed ? active : anchor, reversed ? anchor : active);
      this.active = active;
      this.anchor = anchor;
    }
    get isEmpty() { return this.anchor.isEqual(this.active); }
    isEqual(other: Selection) { return this.anchor.isEqual(other.anchor) && this.active.isEqual(other.active); }
  }
  const disposable = () => ({ dispose: state.disposed });
  return {
    Position, Range, Selection,
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    Hover: class {
      readonly contents: VSCode.MarkdownString[];
      constructor(content: VSCode.MarkdownString, readonly range: Range) { this.contents = [content]; }
    },
    MarkdownString: class { constructor(readonly value: string) {} },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    commands: { executeCommand: state.execute },
    languages: {
      registerHoverProvider: (...args: unknown[]) => { state.registered(...args); return disposable(); },
      registerCodeLensProvider: state.codeLensRegistered
    },
    window: {
      get activeTextEditor() { return state.editor; },
      get state() { return { focused: state.focused }; },
      onDidChangeTextEditorSelection: (listener: typeof state.selectionChanged) => { state.selectionChanged = listener; return disposable(); },
      onDidChangeActiveTextEditor: (listener: typeof state.activeChanged) => { state.activeChanged = listener; return disposable(); },
      onDidChangeWindowState: (listener: typeof state.windowChanged) => { state.windowChanged = listener; return disposable(); }
    },
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "selectionActions.enabled" ? state.enabled : fallback }),
      getWorkspaceFolder: () => state.workspace ? {} : undefined,
      openTextDocument: () => Promise.resolve(state.document),
      onDidChangeTextDocument: (listener: typeof state.documentChanged) => { state.documentChanged = listener; return disposable(); },
      onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: (listener: typeof state.configurationChanged) => { state.configurationChanged = listener; return disposable(); }
    }
  };
});

import * as vscode from "vscode";
import { DextSelectionActions } from "../src/vscodeSelectionActions.js";
import { selectionAttachment, type SelectionTarget } from "../src/vscodeAttachments.js";

function document(languageId = "typescript", version = 3): VSCode.TextDocument {
  return {
    uri: { toString: () => "file:///repo/src/app.ts" }, version, languageId,
    getText: () => "selected code"
  } as unknown as VSCode.TextDocument;
}

let provider: DextSelectionActions;
function hover() { return provider.provideHover(state.document!, state.editor!.selection.active); }
function target(): SelectionTarget {
  const content = hover()!.contents[0] as VSCode.MarkdownString;
  const args = /command:dext.addSelectionToChat\?([^\s]+)/.exec(content.value)![1]!;
  return (JSON.parse(decodeURIComponent(args)) as SelectionTarget[])[0]!;
}
function select(kind = vscode.TextEditorSelectionChangeKind.Mouse) {
  state.selectionChanged?.({ textEditor: state.editor!, kind });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.execute.mockResolvedValue(undefined);
  state.enabled = state.workspace = state.focused = true;
  state.document = document();
  state.editor = {
    document: state.document,
    selection: new vscode.Selection(2, 4, 5, 8),
    visibleRanges: [new vscode.Range(0, 0, 20, 0)]
  } as unknown as VSCode.TextEditor;
  provider = new DextSelectionActions();
});

afterEach(() => { provider.dispose(); vi.useRealTimers(); });

describe("selection Add to Dext overlay", () => {
  it("answers hover queries in an inactive window without automatically opening a popup", async () => {
    state.focused = false;
    expect(hover()).toBeDefined();
    select();
    await vi.runAllTimersAsync();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("uses a hover at the active end without registering a layout-changing CodeLens", () => {
    expect(state.registered).toHaveBeenCalledWith({ language: "*" }, provider);
    expect(state.codeLensRegistered).not.toHaveBeenCalled();
    expect(hover()?.range?.start).toEqual(new vscode.Position(5, 8));
    expect(hover()?.range?.end).toEqual(hover()?.range?.start);
    expect(hover()?.contents[0]).toMatchObject({ isTrusted: { enabledCommands: ["dext.addSelectionToChat"] } });
    expect(target()).toEqual({ uri: "file:///repo/src/app.ts", version: 3,
      range: { start: { line: 2, character: 4 }, end: { line: 5, character: 8 } } });
    expect(provider.provideHover(state.document!, new vscode.Position(3, 0))).toBeUndefined();
  });

  it("anchors reversed selections at the caret while capturing the normalized source range", () => {
    state.editor!.selection = new vscode.Selection(5, 8, 2, 4);
    expect(hover()?.range?.start).toEqual(new vscode.Position(2, 4));
    expect(target().range).toEqual({ start: { line: 2, character: 4 }, end: { line: 5, character: 8 } });
  });

  it("debounces selection movement and displays without taking keyboard focus", async () => {
    select();
    await vi.advanceTimersByTimeAsync(200);
    state.editor!.selection = new vscode.Selection(2, 4, 6, 0);
    select(vscode.TextEditorSelectionChangeKind.Keyboard);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(state.execute).toHaveBeenCalledExactlyOnceWith("editor.action.showHover", { focus: "noAutoFocus" });
  });

  it("hides the action when selection is cleared and cancels delayed display", async () => {
    select();
    await vi.advanceTimersByTimeAsync(250);
    state.editor!.selection = new vscode.Selection(2, 4, 2, 4);
    select();
    expect(hover()).toBeUndefined();
    expect(state.execute).toHaveBeenLastCalledWith("editor.action.hideHover");
    await vi.runAllTimersAsync();
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("applies disable and re-enable immediately", async () => {
    select();
    state.enabled = false;
    state.configurationChanged?.({ affectsConfiguration: () => true });
    await vi.runAllTimersAsync();
    expect(hover()).toBeUndefined();
    expect(state.execute).not.toHaveBeenCalled();
    state.enabled = true;
    state.configurationChanged?.({ affectsConfiguration: () => true });
    await vi.runAllTimersAsync();
    expect(state.execute).toHaveBeenCalledWith("editor.action.showHover", { focus: "noAutoFocus" });
    state.enabled = false;
    state.configurationChanged?.({ affectsConfiguration: () => true });
    expect(state.execute).toHaveBeenLastCalledWith("editor.action.hideHover");
  });

  it("does not offer actions for other documents, prose or files outside the workspace", () => {
    expect(provider.provideHover(document(), state.editor!.selection.active)).toBeUndefined();
    state.workspace = false;
    expect(hover()).toBeUndefined();
    state.workspace = true;
    state.document = document("markdown");
    state.editor = { ...state.editor!, document: state.document };
    expect(hover()).toBeUndefined();
  });

  it.each(["editor", "window", "document", "offscreen", "command", "dispose"])(
    "cancels automatic display on %s changes", async (change) => {
      select();
      if (change === "editor") { state.editor = undefined; state.activeChanged?.(); }
      if (change === "window") { state.focused = false; state.windowChanged?.(); }
      if (change === "document") state.documentChanged?.({ document: state.document! });
      if (change === "offscreen") state.editor = { ...state.editor!, visibleRanges: [] };
      if (change === "command") select(vscode.TextEditorSelectionChangeKind.Command);
      if (change === "dispose") provider.dispose();
      await vi.runAllTimersAsync();
      expect(state.execute).not.toHaveBeenCalled();
    }
  );

  it("ignores selection changes in inactive editors", async () => {
    state.selectionChanged?.({ textEditor: {} as VSCode.TextEditor, kind: vscode.TextEditorSelectionChangeKind.Mouse });
    await vi.runAllTimersAsync();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("handles an unavailable hover command without an unhandled rejection", async () => {
    state.execute.mockRejectedValue(new Error("unavailable"));
    select();
    await vi.runAllTimersAsync();
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the captured file and range when clicking moves focus", async () => {
    const captured = target();
    state.editor = undefined;
    const snapshot = await selectionAttachment(captured);
    expect(snapshot.reference.uri).toBe(captured.uri);
    expect(snapshot.reference.range).toEqual(captured.range);
    expect(snapshot.text).toBe("selected code");
  });

  it("rejects a stale action after the source document changes", async () => {
    const captured = target();
    state.document = document("typescript", 4);
    await expect(selectionAttachment(captured)).rejects.toThrow("selected code has changed");
  });
});
