import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { patchResultFrom } from "./core/patch.js";
import type { ApplyResult, CodeRef, PatchChange, Range } from "./core/types.js";
import type { DeterministicHandler } from "./core/runtime.js";

function vscodeRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
}

async function validatedChange(change: PatchChange): Promise<{
  document: vscode.TextDocument;
  range: vscode.Range;
}> {
  const uri = vscode.Uri.parse(change.uri, true);
  if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) {
    throw new Error("apply only writes files inside the current workspace.");
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const targetRange = change.range ? vscodeRange(change.range) : fullDocumentRange(document);
  if (!document.validateRange(targetRange).isEqual(targetRange)) {
    throw new Error(`Patch range is outside '${document.uri.fsPath}'.`);
  }
  const current = document.getText(targetRange);
  if (current !== change.before) {
    throw new Error(`'${document.uri.fsPath}' changed after the edit preview was created.`);
  }
  if (change.contentHash && contentHash(current) !== change.contentHash) {
    throw new Error(`'${document.uri.fsPath}' no longer matches the edit preview.`);
  }
  return { document, range: targetRange };
}

function codeRef(document: vscode.TextDocument): CodeRef {
  const content = document.getText();
  return {
    kind: "codeRef",
    uri: document.uri.toString(),
    documentVersion: document.version,
    contentHash: contentHash(content),
    content
  };
}

export const applyPatchHandler: DeterministicHandler = async ({ arguments: args }) => {
  if (!vscode.workspace.isTrusted) {
    throw new Error("apply requires a trusted workspace.");
  }
  const patch = patchResultFrom(args.result);
  const changes = patch.changes.filter((change) => change.before !== change.after);
  if (!changes.length) {
    return {
      kind: "apply",
      status: "unchanged",
      files: [],
      summary: "The edit preview contains no changes."
    } satisfies ApplyResult;
  }

  let validated: Awaited<ReturnType<typeof validatedChange>>[];
  try {
    validated = await Promise.all(changes.map(validatedChange));
  } catch (error) {
    return {
      kind: "apply",
      status: "conflict",
      files: [],
      summary: error instanceof Error ? error.message : String(error)
    } satisfies ApplyResult;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const [index, change] of changes.entries()) {
    edit.replace(validated[index]!.document.uri, validated[index]!.range, change.after);
  }
  if (!await vscode.workspace.applyEdit(edit)) {
    return {
      kind: "apply",
      status: "conflict",
      files: [],
      summary: "VS Code could not apply the edit preview."
    } satisfies ApplyResult;
  }

  const documents = await Promise.all(
    [...new Map(validated.map(({ document }) => [document.uri.toString(), document.uri])).values()]
      .map((uri) => vscode.workspace.openTextDocument(uri))
  );
  const saved = await Promise.all(documents.map((document) => document.save()));
  if (saved.some((success) => !success)) {
    return {
      kind: "apply",
      status: "conflict",
      files: documents.map(codeRef),
      summary: "The edit was applied in VS Code, but one or more files could not be saved."
    } satisfies ApplyResult;
  }
  return {
    kind: "apply",
    status: "applied",
    files: documents.map(codeRef),
    summary: `Applied ${changes.length} change${changes.length === 1 ? "" : "s"} to ${documents.length} file${documents.length === 1 ? "" : "s"}.`
  } satisfies ApplyResult;
};
