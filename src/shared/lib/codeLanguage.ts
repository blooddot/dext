/** Fence tag → the Monarch language id `monacoEnvironment` registers.
 *
 * shortcut: only these grammars ship with the webview; a fence with any other tag
 * (sql, go, rust, diff …) stays plain text. Add a `register.js` import and a row here
 * when another language turns up often enough to colour. */
const LANGUAGE_IDS: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  javascript: "javascript", ts: "typescript", tsx: "typescript", typescript: "typescript",
  // Monaco's JSON mode is worker-backed; the JavaScript grammar colours the same shapes.
  json: "javascript", jsonc: "javascript",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown",
  py: "python", python: "python", python3: "python"
};

/** The language id a fenced block's tag maps to, or undefined when it is not coloured. */
export function codeLanguageId(fenceTag: string): string | undefined {
  return LANGUAGE_IDS[fenceTag.trim().toLowerCase()];
}
