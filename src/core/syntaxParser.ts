import { join, resolve } from "node:path";
// Select the CJS binding so the extension bundle retains the WASM loader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import TreeSitter = require("web-tree-sitter");

const { Parser, Language } = TreeSitter;
let parserInit: Promise<void> | undefined;
const languages = new Map<string, Promise<TreeSitter.Language>>();

export async function parserFor(language: string, assetsPath?: string): Promise<TreeSitter.Parser> {
  const asset = (name: string): string => assetsPath ? join(assetsPath, name)
    : resolve(process.cwd(), "node_modules", name === "web-tree-sitter.wasm" ? "web-tree-sitter" : `tree-sitter-${language === "tsx" ? "typescript" : language}`, name);
  parserInit ??= Parser.init({ locateFile: () => asset("web-tree-sitter.wasm") });
  await parserInit;
  const path = asset(`tree-sitter-${language}.wasm`);
  let pending = languages.get(path);
  if (!pending) { pending = Language.load(path); languages.set(path, pending); }
  const grammar = await pending;
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

