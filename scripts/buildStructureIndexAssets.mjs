import { copyFile, mkdir } from 'node:fs/promises';

export const structureIndexAssets = [
  ['web-tree-sitter', 'web-tree-sitter.wasm'],
  ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
  ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
  ['tree-sitter-python', 'tree-sitter-python.wasm']
];

export async function buildStructureIndexAssets() {
  await mkdir('dist/structure-index', { recursive: true });
  for (const [pkg, file] of structureIndexAssets) {
    await copyFile(`node_modules/${pkg}/${file}`, `dist/structure-index/${file}`);
    await copyFile(`node_modules/${pkg}/LICENSE`, `dist/structure-index/${pkg}.LICENSE`);
  }
}
