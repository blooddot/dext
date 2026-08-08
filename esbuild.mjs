import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const context = await esbuild.context({
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
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
  await mkdir("dist/codicons", { recursive: true });
  await Promise.all([
    copyFile("node_modules/@vscode/codicons/dist/codicon.css", "dist/codicons/codicon.css"),
    copyFile("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicons/codicon.ttf")
  ]);
}
