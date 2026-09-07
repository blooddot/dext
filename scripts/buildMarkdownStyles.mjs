import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { transform } from "esbuild";

/** Scope upstream themes to VS Code's live theme classes, not OS preferences. */
export async function buildMarkdownStyles() {
  const themes = await Promise.all(["light", "dark"].map(async (theme) => {
    const source = await readFile(`node_modules/github-markdown-css/github-markdown-${theme}.css`, "utf8");
    const classes = theme === "light"
      ? "body.vscode-light, body.vscode-high-contrast-light"
      : "body.vscode-dark, body.vscode-high-contrast";
    // :where preserves upstream specificity so the small Webview adapter wins.
    return source.replaceAll(".markdown-body", `:where(${classes}) .markdown-body`);
  }));
  const { code } = await transform(themes.join("\n"), { loader: "css", minify: true, target: "es2022" });
  await mkdir("dist/markdown", { recursive: true });
  await writeFile("dist/markdown/github-markdown.css", `/*! github-markdown-css (MIT); see LICENSE */\n${code}`);
  await copyFile("node_modules/github-markdown-css/license", "dist/markdown/LICENSE");
}
