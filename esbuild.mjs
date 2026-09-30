import * as esbuild from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { buildMarkdownStyles } from "./scripts/buildMarkdownStyles.mjs";
import { writeShippedDeclaration } from "./scripts/generateDextTypes.mjs";
import { writeApiReference } from "./scripts/generateApiReference.mjs";

const watch = process.argv.includes("--watch");
await buildMarkdownStyles();
// The generated `dext` declaration ships with the extension as `dist/dext.d.ts`,
// so a workspace never carries its own copy of the API surface; `npm run check`
// proves the shipped file still matches the registry.
await writeShippedDeclaration();
// The Node and JavaScript reference the APIs page lists is generated from the
// declaration files themselves, so its signatures and descriptions stay the ones
// the editor resolves; `npm run check` proves the shipped file matches them too.
await writeApiReference();
const contexts = await Promise.all([
  esbuild.context({
    entryPoints: {
      extension: "src/extension.ts",
      extensionHostTest: "test/extensionHost.ts"
    },
    bundle: true,
    outdir: "dist",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
    metafile: true,
    logLevel: "info"
  }),

  esbuild.context({
    entryPoints: {
      main: "src/webview/main.ts",
      "editor.worker": "node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
      // The composer is a TypeScript editor, so Monaco's TypeScript worker is
      // bundled next to the editor worker and loaded from a blob URL by
      // `src/webview/monacoTypescript.ts`.
      "ts.worker": "node_modules/monaco-editor/esm/vs/languages/features/typescript/ts.worker.js"
    },
    bundle: true,
    outdir: "dist/webview",
    platform: "browser",
    format: "iife",
    target: "es2022",
    loader: { ".ttf": "file" },
    assetNames: "assets/[name]-[hash]",
    minify: true,
    metafile: true,
    logLevel: "info"
  }),
  // The kernel, its loader and the `dext` runtime module are ESM files that the
  // kernel is started with (`--import ./dist/dextLoader.mjs`), so they are built
  // as separate ESM entries instead of being bundled into the CJS extension.
  // esbuild stays a development dependency: the loader imports it lazily and only
  // when the runtime cannot strip TypeScript itself.
  esbuild.context({
    // Names must match the sources: the loader resolves `dext` and the kernel
    // registers the loader by the sibling file name, in `src/runner` and `dist`
    // alike.
    entryPoints: {
      dextLoader: "src/runner/dextLoader.mjs",
      dextKernel: "src/runner/dextKernel.mjs",
      dextRuntime: "src/runner/dextRuntime.mjs",
      dextSerialization: "src/runner/dextSerialization.mjs"
    },
    // `dext` is not a package: the kernel resolves it through its own loader, which
    // maps it to the runtime file user code imports. Bundling that module into the
    // kernel instead gives the kernel a second instance with its own in-flight
    // registry, so a run that called an API without `await` is reported finished
    // while the call — and the agent behind it — is still running.
    external: ["dext"],
    bundle: true,
    outdir: "dist",
    platform: "node",
    format: "esm",
    // The package is CommonJS, so the kernel files must keep the .mjs extension
    // they are loaded with.
    outExtension: { ".js": ".mjs" },
    target: "node20",
    sourcemap: true,
    metafile: true,
    logLevel: "info"
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  const results = await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  await mkdir("dist/codicons", { recursive: true });
  await Promise.all([
    copyFile("node_modules/@vscode/codicons/dist/codicon.css", "dist/codicons/codicon.css"),
    copyFile("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicons/codicon.ttf")
  ]);
  // Build dependency manifest: lets the asset check prove which inputs actually reach the runtime
  // entry instead of trusting that node_modules is hidden from the package.
  const manifest = {
    schemaVersion: 1,
    outputs: Object.fromEntries([
      ...Object.entries(results[0]).filter(([key]) => key !== "metafile"),
      ...Object.entries(results[1]).filter(([key]) => key !== "metafile"),
      ...Object.entries(results[2]).filter(([key]) => key !== "metafile")
    ]),
    entryInputs: {
      extension: Object.keys(results[0].metafile.inputs).sort(),
      webview: Object.keys(results[1].metafile.inputs).sort(),
      kernel: Object.keys(results[2].metafile.inputs).sort()
    },
    metafiles: { extension: results[0].metafile, webview: results[1].metafile, kernel: results[2].metafile }
  };
  await writeFile("dist/build-meta.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
