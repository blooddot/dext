import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const directory = dirname(fileURLToPath(import.meta.url));
export async function readSidebarBody() {
  const workspace = resolve(directory, '../..');
  const { outputFiles } = await build({
    stdin: {
      contents: `import { DextSidebarProvider } from './src/app/sidebarProvider.ts';
        export function render() {
          const provider = Object.create(DextSidebarProvider.prototype);
          return provider.html({ cspSource: 'https://webview.test', asWebviewUri: uri => uri });
        }`,
      resolveDir: workspace,
      sourcefile: 'sidebarFixture.ts'
    },
    absWorkingDir: workspace, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']
  });
  const fixture = { exports: {} };
  const require = createRequire(resolve(workspace, 'package.json'));
  const vscode = {
    Uri: { joinPath: (...parts) => ({ fsPath: '', toString: () => parts.slice(1).join('/'), with() { return this; } }) },
    workspace: { getConfiguration: () => ({ get: () => undefined }) }
  };
  new Function('module', 'require', '__dirname', '__filename', outputFiles[0].text)(
    fixture, name => name === 'vscode' ? vscode : require(name), workspace, resolve(workspace, 'sidebarFixture.ts')
  );
  const template = fixture.exports.render();
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/.exec(template)?.[1];
  if (body === undefined) throw new Error('Missing sidebar body template');
  return body.replace(/<script[\s\S]*?<\/script>/g, '');
}

export async function startLab(port = 0) {
  const outdir = join(directory, 'dist');
  await mkdir(outdir, { recursive: true });
  // Built exactly like the shipped Webview (`format: 'iife'`, no code splitting) on
  // purpose: a split build gives `monaco-editor/…/typescript/register.js` one instance
  // per graph, so the editor's providers would read the defaults of one module while the
  // host's declaration is added to another, and the lab would "verify" a composer whose
  // TypeScript service never saw `dext.d.ts`. The workers are also fetched and run from
  // a blob URL, which is a classic script and cannot execute a code-split module.
  // Everything is resolved from the repository root for the same reason: the lab
  // directory has its own `node_modules` (`package.json` installs `dext` and Monaco for
  // it), so a bare `monaco-editor` import from here would bundle that copy beside the
  // one `src/` imports — one Monaco for the editor and another for the TypeScript
  // contribution, which is the "no language feature" failure this lab exists to catch.
  const { outputFiles } = await build({ absWorkingDir: resolve(directory, '../..'), entryPoints: {
    main: 'scripts/monaco-ref-lab/main.ts',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
    // The composer is TypeScript now, so the lab needs Monaco's TypeScript worker
    // as well; without it the editor silently loses every language feature.
    'ts.worker': 'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'
  }, outdir,
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', loader: { '.ttf': 'file' }, logLevel: 'warning', write: false });
  await Promise.all(outputFiles.map(file => writeFile(file.path, file.contents)));
  const html = await readFile(join(directory, 'index.html'));
  const webview = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>';
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      // Serve only the generated assets, never workspace files or node_modules.
      const asset = /^\/assets\/([A-Za-z0-9_.-]+)$/.exec(path)?.[1];
      if (path === '/dext.d.ts') {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(await readFile(join(directory, '../../.dext/api/dext.d.ts')));
        return;
      }
      const page = path === '/' ? html : path === '/webview' ? webview : undefined;
      if (!page && !asset) { response.writeHead(404).end(); return; }
      // The composer loads its TypeScript worker from a blob URL (the Webview cannot load
      // it any other way), so `worker-src` has to allow `blob:` exactly as the Webview's
      // own CSP does; without it the editor silently loses every language feature.
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self';");
      response.setHeader('Content-Type', page ? 'text/html; charset=utf-8' : asset.endsWith('.css') ? 'text/css' : asset.endsWith('.ttf') ? 'font/ttf' : 'text/javascript');
      response.end(page ?? await readFile(join(outdir, asset)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await startLab(Number(process.env.DEXT_REF_LAB_PORT || 4318));
  console.log(`Monaco ref lab: ${url}`);
}
