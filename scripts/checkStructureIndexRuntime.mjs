import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Exercise the production CJS bundling path, not just the unbundled development dependency.
export async function checkStructureIndexRuntime() {
  const outfile = resolve('.tmp-tb/structure-index-runtime.cjs');
  await build({ entryPoints: ['src/platform/node/syntaxParser.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20' });
  const { parserFor } = await import(pathToFileURL(outfile).href);
  const parser = await parserFor('typescript', resolve('dist/structure-index'));
  const tree = parser.parse('export function entry(value: number): number { return value; }');
  assert.equal(tree?.rootNode.type, 'program');
  assert.ok(tree.rootNode.namedChildCount > 0, 'The bundled parser produced no syntax nodes.');
  console.log('PASS: bundled syntax parser loads the shipped TypeScript WASM grammar.');
}
