import * as esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await rm("dist/webview/editor.worker.js", { force: true });
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
    logLevel: "info"
  }),
  esbuild.context({
    entryPoints: { main: "src/webview/main.ts" },
    bundle: true,
    outdir: "dist/webview",
    platform: "browser",
    format: "iife",
    target: "es2022",
    logLevel: "info"
  })
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  await mkdir("dist/codicons", { recursive: true });
  await Promise.all([
    copyFile("node_modules/@vscode/codicons/dist/codicon.css", "dist/codicons/codicon.css"),
    copyFile("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicons/codicon.ttf")
  ]);
}
