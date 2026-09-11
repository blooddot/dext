import * as vscode from "vscode";
import { apiDefinitionTarget, apiFunctionDefinition, builtinApiDefinitionTarget, builtinTypeDefinitionTarget, builtinTypeReferenceTarget } from "./core/apiNavigation.js";
import { builtinTypeDocument } from "./core/builtinTypeDefinitions.js";
import { builtinApiDocument, builtinApiReferenceTarget } from "./core/builtinApiDefinitions.js";
import { builtinMemberDefinitionTarget } from "./core/builtinMemberNavigation.js";

const BUILTIN_TYPES_SCHEME = "dext-types";
const BUILTIN_TYPES_PATH = "/builtin-types.dx";
const BUILTIN_APIS_SCHEME = "dext-builtins";
const BUILTIN_APIS_PATH = "/builtin-apis.dx";

function builtinTypesUri(): vscode.Uri {
  return vscode.Uri.parse(`${BUILTIN_TYPES_SCHEME}:${BUILTIN_TYPES_PATH}`);
}

function builtinApisUri(): vscode.Uri {
  return vscode.Uri.parse(`${BUILTIN_APIS_SCHEME}:${BUILTIN_APIS_PATH}`);
}

export class DextBuiltinTypesContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return builtinTypeDocument().text;
  }
}

export class DextBuiltinApisContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return builtinApiDocument().text;
  }
}

/** Open a built-in API reference from the sidebar as well as from F12. */
export async function openBuiltinApiDefinition(id: string): Promise<void> {
  const definition = builtinApiDocument().ranges.get(id);
  if (!definition) return;
  const document = await vscode.workspace.openTextDocument(builtinApisUri());
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const target = new vscode.Range(
    offsetPosition(definition.nameFrom, builtinApiDocument().text),
    offsetPosition(definition.nameTo, builtinApiDocument().text)
  );
  editor.selection = new vscode.Selection(target.start, target.end);
  editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export class DextApiDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly sourcePath: (apiId: string) => string | undefined) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.DefinitionLink[] | undefined> {
    if (token.isCancellationRequested) return undefined;
    const source = document.getText();
    const cursor = document.offsetAt(position);
    const builtinType = (document.uri.scheme === BUILTIN_TYPES_SCHEME
      ? builtinTypeReferenceTarget(source, cursor)
      : builtinTypeDefinitionTarget(source, cursor)) ?? builtinMemberDefinitionTarget(source, cursor);
    if (builtinType) {
      const typeDocument = builtinTypeDocument();
      const definition = "field" in builtinType && typeof builtinType.field === "string"
        ? typeDocument.fieldRanges.get(`${builtinType.name}.${builtinType.field}`)
        : typeDocument.ranges.get(builtinType.name);
      if (!definition) return undefined;
      const targetUri = builtinTypesUri();
      return [{
        originSelectionRange: new vscode.Range(document.positionAt(builtinType.originFrom), document.positionAt(builtinType.originTo)),
        targetUri,
        targetRange: new vscode.Range(offsetPosition(definition.from), offsetPosition(definition.to)),
        targetSelectionRange: new vscode.Range(offsetPosition(definition.nameFrom), offsetPosition(definition.nameTo))
      }];
    }
    const builtinApi = document.uri.scheme === BUILTIN_APIS_SCHEME
      ? builtinApiReferenceTarget(source, cursor)
      : builtinApiDefinitionTarget(source, cursor);
    if (builtinApi) {
      const definition = builtinApiDocument().ranges.get(builtinApi.id);
      if (!definition) return undefined;
      return [{
        originSelectionRange: new vscode.Range(document.positionAt(builtinApi.originFrom), document.positionAt(builtinApi.originTo)),
        targetUri: builtinApisUri(),
        targetRange: new vscode.Range(offsetPosition(definition.from, builtinApiDocument().text), offsetPosition(definition.to, builtinApiDocument().text)),
        targetSelectionRange: new vscode.Range(offsetPosition(definition.nameFrom, builtinApiDocument().text), offsetPosition(definition.nameTo, builtinApiDocument().text))
      }];
    }
    const reference = apiDefinitionTarget(source, cursor);
    if (!reference) return undefined;
    let target = document;
    if (reference.apiId) {
      const path = this.sourcePath(reference.apiId);
      if (!path) return undefined;
      try {
        // openTextDocument reuses dirty editor buffers, so unsaved edits retain
        // the correct main() position instead of jumping to a stale disk offset.
        target = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      } catch { return undefined; }
    }
    if (token.isCancellationRequested) return undefined;
    const definition = apiFunctionDefinition(target.getText(), reference.name);
    if (!definition) return undefined;
    return [{
      originSelectionRange: new vscode.Range(document.positionAt(reference.originFrom), document.positionAt(reference.originTo)),
      targetUri: target.uri,
      targetRange: new vscode.Range(target.positionAt(definition.from), target.positionAt(definition.to)),
      targetSelectionRange: new vscode.Range(target.positionAt(definition.nameFrom), target.positionAt(definition.nameTo))
    }];
  }
}

function offsetPosition(offset: number, text = builtinTypeDocument().text): vscode.Position {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return new vscode.Position(line, offset - (before.lastIndexOf("\n") + 1));
}
