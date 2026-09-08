import * as vscode from "vscode";
import { apiDefinitionTarget, apiFunctionDefinition } from "./core/apiNavigation.js";

export class DextApiDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly sourcePath: (apiId: string) => string | undefined) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.DefinitionLink[] | undefined> {
    if (token.isCancellationRequested) return undefined;
    const reference = apiDefinitionTarget(document.getText(), document.offsetAt(position));
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
