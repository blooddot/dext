import * as vscode from "vscode";
import { activeWorkspaceSelection, type SelectionTarget } from "./vscodeAttachments.js";

/** Use the editor's overlay hover so selecting text never inserts a layout row.
 * Capture the source in the link so clicking cannot change the selected target. */
export class DextSelectionActions implements vscode.HoverProvider, vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private pending: ReturnType<typeof setTimeout> | undefined;
  private shownEditor: vscode.TextEditor | undefined;

  constructor() {
    this.subscriptions = [
      vscode.languages.registerHoverProvider({ language: "*" }, this),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) return;
        this.refresh(event.kind !== vscode.TextEditorSelectionChangeKind.Command);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh(false)),
      vscode.window.onDidChangeWindowState(() => this.refresh(false)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.refresh(false);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("dext.selectionActions.enabled")) this.refresh(true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh(false))
    ];
  }

  private selectedEditor(): vscode.TextEditor | undefined {
    const editor = activeWorkspaceSelection();
    if (!editor
      || !vscode.workspace.getConfiguration("dext", editor.document.uri).get<boolean>("selectionActions.enabled", true)) return;
    return editor;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const editor = this.selectedEditor();
    if (!editor || editor.document !== document || !position.isEqual(editor.selection.active)) return;

    const { start, end } = editor.selection;
    const target: SelectionTarget = {
      uri: document.uri.toString(),
      version: document.version,
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character }
      }
    };
    const args = encodeURIComponent(JSON.stringify([target]));
    const content = new vscode.MarkdownString(
      `[Add to Dext](command:dext.addSelectionToChat?${args} "Add the selected text to Dext Input as a file reference")`
    );
    content.isTrusted = { enabledCommands: ["dext.addSelectionToChat"] };
    return new vscode.Hover(content, new vscode.Range(editor.selection.active, editor.selection.active));
  }

  private refresh(show: boolean): void {
    this.clearPending();
    this.hide();
    const editor = this.selectedEditor();
    if (!show || !editor || !vscode.window.state.focused) return;
    const selection = editor.selection;
    const version = editor.document.version;
    // Wait for dragging / Shift+Arrow to settle. Never move the caret or take
    // keyboard focus; showHover anchors itself at the active selection end.
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (!vscode.window.state.focused || this.selectedEditor() !== editor || editor.document.version !== version
        || !editor.selection.isEqual(selection)
        || !editor.visibleRanges.some((range) => range.contains(selection.active))) return;
      this.shownEditor = editor;
      void vscode.commands.executeCommand("editor.action.showHover", { focus: "noAutoFocus" }).then(
        undefined,
        () => { if (this.shownEditor === editor) this.shownEditor = undefined; }
      );
    }, 250);
  }

  private clearPending(): void {
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
  }

  private hide(): void {
    // Do not dismiss a different editor's hover after focus has moved.
    if (this.shownEditor && this.shownEditor === vscode.window.activeTextEditor) {
      void vscode.commands.executeCommand("editor.action.hideHover").then(undefined, () => undefined);
    }
    this.shownEditor = undefined;
  }

  dispose(): void {
    this.clearPending();
    this.hide();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
