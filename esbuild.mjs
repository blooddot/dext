import * as esbuild from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { buildMarkdownStyles } from "./scripts/buildMarkdownStyles.mjs";

const watch = process.argv.includes("--watch");
await buildMarkdownStyles();
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
    entryPoints: { main: "src/webview/main.ts", "editor.worker": "node_modules/monaco-editor/esm/vs/editor/editor.worker.js" },
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
  })
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
      ...Object.entries(results[1]).filter(([key]) => key !== "metafile")
    ]),
    entryInputs: {
      extension: Object.keys(results[0].metafile.inputs).sort(),
      webview: Object.keys(results[1].metafile.inputs).sort()
    },
    metafiles: { extension: results[0].metafile, webview: results[1].metafile }
  };
  await writeFile("dist/build-meta.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
