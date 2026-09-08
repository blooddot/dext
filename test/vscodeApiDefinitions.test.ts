import type * as VSCode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openTextDocument = vi.hoisted(() => vi.fn());
vi.mock("vscode", () => ({
  Uri: { file: (path: string) => ({ fsPath: path }) },
  Range: class { constructor(readonly start: VSCode.Position, readonly end: VSCode.Position) {} },
  workspace: { openTextDocument }
}));

import { DextApiDefinitionProvider } from "../src/vscodeApiDefinitions.js";

function document(source: string, path: string): VSCode.TextDocument {
  return {
    uri: { fsPath: path },
    getText: () => source,
    offsetAt: (position: VSCode.Position) => position.character,
    positionAt: (offset: number) => ({ line: 0, character: offset })
  } as VSCode.TextDocument;
}

const token = { isCancellationRequested: false } as VSCode.CancellationToken;
const source = "from playground import verify\nverify()";

describe("VS Code .dx definition provider", () => {
  beforeEach(() => { openTextDocument.mockReset(); });

  it("uses the registered source path and the live target document's main position", async () => {
    const path = "C:/global storage/api/playground/verify.dx";
    const lookup = vi.fn(() => path);
    const provider = new DextApiDefinitionProvider(lookup);
    const targetSource = '# unsaved new line\n\ndef helper():\n    pass\n\ndef main():\n    return helper()';
    const target = document(targetSource, path);
    openTextDocument.mockResolvedValue(target);
    const current = document(source, "C:/project/.dext/api/develop.dx");
    for (const offset of [source.indexOf("verify"), source.lastIndexOf("verify")]) {
      const links = await provider.provideDefinition(current, current.positionAt(offset + 1), token);
      expect(lookup).toHaveBeenLastCalledWith("playground.verify");
      expect(openTextDocument).toHaveBeenLastCalledWith({ fsPath: path });
      expect(links?.[0]?.targetUri).toBe(target.uri);
      expect(links?.[0]?.targetSelectionRange?.start.character).toBe(targetSource.indexOf("main"));
    }
  });

  it("jumps to a local helper in an unsaved buffer without opening another file", async () => {
    const source = 'def main():\n    return report()\n\ndef report():\n    return print(text="ok")';
    const current = document(source, "C:/project/develop.dx");
    const provider = new DextApiDefinitionProvider(() => undefined);
    const links = await provider.provideDefinition(current, current.positionAt(source.indexOf("report") + 2), token);
    expect(links?.[0]?.targetUri).toBe(current.uri);
    expect(links?.[0]?.targetSelectionRange?.start.character).toBe(source.lastIndexOf("report"));
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it("handles missing APIs, deleted targets and cancellation without stale links", async () => {
    const current = document(source, "C:/project/develop.dx");
    const position = current.positionAt(source.lastIndexOf("verify") + 1);
    const lookup = vi.fn<() => string | undefined>(() => undefined);
    const provider = new DextApiDefinitionProvider(lookup);
    expect(await provider.provideDefinition(current, position, token)).toBeUndefined();
    expect(openTextDocument).not.toHaveBeenCalled();
    lookup.mockReturnValue("C:/missing.dx");
    openTextDocument.mockRejectedValue(new Error("File not found"));
    expect(await provider.provideDefinition(current, position, token)).toBeUndefined();
    openTextDocument.mockClear();
    expect(await provider.provideDefinition(current, position, { isCancellationRequested: true } as VSCode.CancellationToken)).toBeUndefined();
    expect(openTextDocument).not.toHaveBeenCalled();
  });
});
