import { join, resolve } from "node:path";
// Select the CJS binding so the extension bundle retains the WASM loader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import TreeSitter = require("web-tree-sitter");

const { Parser, Language } = TreeSitter;
// Keyed by the resolved core path: a later caller with a different assetsPath must not silently
// reuse the first caller's wasm location.
const parserInits = new Map<string, Promise<void>>();
const languages = new Map<string, Promise<TreeSitter.Language>>();

export async function parserFor(language: string, assetsPath?: string): Promise<TreeSitter.Parser> {
  const asset = (name: string): string => assetsPath ? join(assetsPath, name)
    : resolve(process.cwd(), "node_modules", name === "web-tree-sitter.wasm" ? "web-tree-sitter" : `tree-sitter-${language === "tsx" ? "typescript" : language}`, name);
  const core = asset("web-tree-sitter.wasm");
  let init = parserInits.get(core);
  if (!init) { init = Parser.init({ locateFile: () => core }); parserInits.set(core, init); }
  await init;
  const path = asset(`tree-sitter-${language}.wasm`);
  let pending = languages.get(path);
  if (!pending) { pending = Language.load(path); languages.set(path, pending); }
  const grammar = await pending;
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

