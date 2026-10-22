import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Exercise the production CJS bundling path, not just the unbundled development dependency.
export async function checkStructureIndexRuntime() {
  const outfile = resolve('.tmp-tb/structure-index-runtime.cjs');
  await build({ entryPoints: ['src/features/project/host/indexing/projectStructure.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20' });
  const { buildStructureIndex } = await import(pathToFileURL(outfile).href);
  const index = await buildStructureIndex([
    { path: 'main.js', content: 'export function main() {}' },
    { path: 'main.ts', content: 'export interface App {}' },
    { path: 'main.tsx', content: 'export function View() { return <div/>; }' },
    { path: 'main.rs', content: 'fn main() {}' },
    { path: 'main.py', content: 'def main(): pass' }
  ], { assetsPath: resolve('dist/structure-index') });
  assert.equal(index.summary.parsed, 5);
  assert.equal(index.summary.failed, 0);
  console.log('PASS: bundled structure index loads all five shipped WASM grammars.');
}
