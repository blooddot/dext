import { monaco } from "./monacoEnvironment.js";
import type { LanguageRequestBroker } from "./languageClient.js";
import type { FileSearchClient } from "./fileSearchClient.js";
import type { ProjectReferenceClient } from "./projectReferenceClient.js";
import type { ReferenceProjection } from "./monacoReferences.js";
import { pythonHoverCode } from "../vscodeHover.js";
import { parser } from "@lezer/python";

export interface MonacoLanguageContext {
  model: monaco.editor.ITextModel;
  editor: monaco.editor.IStandaloneCodeEditor;
  projection: ReferenceProjection;
  broker: LanguageRequestBroker;
  files: FileSearchClient;
  projects?: ProjectReferenceClient;
  source(): string;
  enabled(): boolean;
  revision(): number;
  range(from: number, to: number): monaco.Range;
}

export function registerMonacoLanguage(c: MonacoLanguageContext): { dispose(): void } {
  const selectors = [{ language: "python", scheme: "dext-input" }, { language: "plaintext", scheme: "dext-input" }];
  const snapshot = () => { const version = c.revision(); return () => !c.model.isDisposed() && c.revision() === version; };
  const offset = (position: monaco.Position) => c.projection.toSource(c.model.getValue(), c.model.getOffsetAt(position));
  const registrations: monaco.IDisposable[] = [];
  const targets = new Map<string, { source: string; cursor: number }>();
  const previews = new Map<string, monaco.editor.ITextModel>();
  registrations.push(monaco.languages.registerCompletionItemProvider(selectors, {
    triggerCharacters: [".", "@", "#", "(", ","],
    async provideCompletionItems(model, position, _context, token) {
      if (model !== c.model) return undefined;
      const valid = snapshot(), source = c.source(), cursor = offset(position);
      const project = /#[\p{L}\p{N}_.%-]*$/u.exec(source.slice(0, cursor));
      if (project && c.projects && !/[\p{L}\p{N}_./@#%+-]/u.test(source[project.index - 1] ?? "")) {
        const items = await c.projects.search(project[0].slice(1));
        if (!valid() || token.isCancellationRequested) return undefined;
        return { suggestions: items.map((item, i) => ({
          label: `#${item.canonicalName}`, detail: `${item.displayName ?? item.canonicalName} · ${item.kind}`,
          kind: monaco.languages.CompletionItemKind.Module, range: c.range(project.index, cursor),
          insertText: c.projection.encode(item.token), filterText: project[0], sortText: String(i).padStart(5, "0")
        })) };
      }
      const file = /@[^\s@#"'`(){}[\],]*$/.exec(source.slice(0, cursor));
      if (file && !/[\p{L}\p{N}_.+-]/u.test(source[file.index - 1] ?? "")) {
        const files = await c.files.search(file[0].slice(1));
        if (!valid() || token.isCancellationRequested) return undefined;
        return { suggestions: files.map((path, i) => ({ label: `@${path}`, detail: path, kind: monaco.languages.CompletionItemKind.File,
          range: c.range(file.index, cursor), insertText: c.projection.encode(`@${path} `), filterText: file[0], sortText: String(i).padStart(5, "0") })) };
      }
      if (!c.enabled()) return undefined;
      const result = await c.broker.request(source, cursor, token, "completion");
      if (!result || !valid() || token.isCancellationRequested) return undefined;
      return { suggestions: result.completions.map((item, i) => ({
        label: item.label, detail: item.detail, sortText: item.sortText ?? String(i).padStart(5, "0"),
        kind: item.kind === "namespace" ? monaco.languages.CompletionItemKind.Module : item.kind === "method" ? monaco.languages.CompletionItemKind.Function : item.kind === "parameter" ? monaco.languages.CompletionItemKind.Property : monaco.languages.CompletionItemKind.Value,
        range: c.range(item.replaceStart, item.replaceEnd),
        insertText: item.insertText.includes('""') ? item.insertText.replaceAll("$", "\\$").replace('""', '"${0}"') : item.insertText,
        insertTextRules: item.insertText.includes('""') ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : monaco.languages.CompletionItemInsertTextRule.None,
        ...(item.kind === "method" ? { command: { id: "editor.action.triggerParameterHints", title: "Parameter hints" } } : item.kind === "namespace" ? { command: { id: "editor.action.triggerSuggest", title: "Suggestions" } } : {})
      })) };
    }
  }));
  registrations.push(monaco.languages.registerSignatureHelpProvider(selectors[0]!, {
    signatureHelpTriggerCharacters: ["(", ","], signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position, token, context) {
      if (model !== c.model || !c.enabled()) return undefined;
      const source = c.source(), cursor = offset(position);
      if (!context.isRetrigger && context.triggerKind !== monaco.languages.SignatureHelpTriggerKind.Invoke) {
        for (let node = parser.parse(source).resolveInner(Math.max(0, cursor - 1), 1); node; node = node.parent!) {
          if (["String", "FormatString", "Comment"].includes(node.name)) return undefined;
        }
      }
      const valid = snapshot();
      const result = await c.broker.request(source, cursor, token, "signature");
      if (!valid() || token.isCancellationRequested || !result?.signature) return undefined;
      const signature = result.signature;
      return { value: { signatures: [{ label: signature.label, documentation: signature.documentation,
        parameters: signature.parameters }], activeSignature: 0, activeParameter: signature.activeParameter }, dispose() {} };
    }
  }));
  registrations.push(monaco.languages.registerHoverProvider(selectors[0]!, {
    async provideHover(model, position, token) {
      if (model !== c.model || !c.enabled()) return undefined;
      const valid = snapshot(), cursor = offset(position);
      const result = await c.broker.request(c.source(), cursor, token, "hover");
      const hover = result?.hover;
      if (!valid() || token.isCancellationRequested || !hover || cursor < hover.rangeStart || cursor >= hover.rangeEnd) return undefined;
      return { range: c.range(hover.rangeStart, hover.rangeEnd), contents: [
        { value: "```python\n" + pythonHoverCode(hover.label, hover.kind) + "\n```" }, { value: hover.documentation, isTrusted: false }
      ] };
    }
  }));
  registrations.push(monaco.languages.registerDefinitionProvider(selectors[0]!, {
    async provideDefinition(model, position, token) {
      if (model !== c.model || !c.enabled()) return undefined;
      const valid = snapshot(), source = c.source(), cursor = offset(position);
      const target = await c.broker.definition(source, cursor, token);
      if (!valid() || token.isCancellationRequested || !target) return undefined;
      const local = target.uri.startsWith("dext-input:");
      let range = monaco.Range.lift(target.range);
      if (local) {
        const lines = source.split("\n");
        const at = (line: number, column: number) => lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
        range = c.range(at(range.startLineNumber, range.startColumn), at(range.endLineNumber, range.endColumn));
      } else {
        const uri = monaco.Uri.parse(target.uri), key = uri.toString();
        targets.set(key, { source, cursor });
        // Native Ctrl+hover resolves a model to display a definition preview.
        // Reading that preview must never open a host editor.
        if (target.content !== undefined) {
          const existing = previews.get(key);
          if (existing && existing.getValue() !== target.content) existing.setValue(target.content);
          else if (!existing && !monaco.editor.getModel(uri)) previews.set(key, monaco.editor.createModel(target.content, "python", uri));
          if (previews.size > 16) { const oldest = previews.keys().next().value!; previews.get(oldest)!.dispose(); previews.delete(oldest); targets.delete(oldest); }
        }
      }
      return [{ uri: local ? model.uri : monaco.Uri.parse(target.uri), range, originSelectionRange: c.range(target.originFrom, target.originTo) }];
    }
  }));
  registrations.push(monaco.editor.registerEditorOpener({ openCodeEditor(editor, uri) {
    if (editor !== c.editor) return false;
    const target = targets.get(uri.toString());
    if (!target || target.source !== c.source()) return false;
    c.broker.openDefinition(target.source, target.cursor); return true;
  } }));
  return { dispose() { registrations.forEach(item => item.dispose()); targets.clear(); for (const model of previews.values()) model.dispose(); previews.clear(); } };
}
