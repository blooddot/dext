import { copyFile, mkdir } from 'node:fs/promises';

export const projectIndexAssets = [
  ['web-tree-sitter', 'web-tree-sitter.wasm'],
  ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
  ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
  ['tree-sitter-python', 'tree-sitter-python.wasm']
];

export async function buildProjectIndexAssets() {
  await mkdir('dist/project-index', { recursive: true });
  for (const [pkg, file] of projectIndexAssets) {
    await copyFile(`node_modules/${pkg}/${file}`, `dist/project-index/${file}`);
    await copyFile(`node_modules/${pkg}/LICENSE`, `dist/project-index/${pkg}.LICENSE`);
  }
}
