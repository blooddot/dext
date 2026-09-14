import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const directory = dirname(fileURLToPath(import.meta.url));
export async function startLab(port = 0) {
  const outdir = join(directory, 'dist');
  await mkdir(outdir, { recursive: true });
  await build({ absWorkingDir: directory, entryPoints: { main: 'main.ts', 'editor.worker': '../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js' }, outdir,
    bundle: true, format: 'esm', splitting: true, platform: 'browser', target: 'es2022', loader: { '.ttf': 'file' }, logLevel: 'warning' });
  const html = await readFile(join(directory, 'index.html'));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      // Serve only the generated assets, never workspace files or node_modules.
      const asset = /^\/assets\/([A-Za-z0-9_.-]+)$/.exec(path)?.[1];
      if (path !== '/' && !asset) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self';");
      response.setHeader('Content-Type', path === '/' ? 'text/html; charset=utf-8' : asset.endsWith('.css') ? 'text/css' : asset.endsWith('.ttf') ? 'font/ttf' : 'text/javascript');
      response.end(path === '/' ? html : await readFile(join(outdir, asset)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await startLab(Number(process.env.DEXT_REF_LAB_PORT || 4318));
  console.log(`Monaco ref lab: ${url}`);
}
