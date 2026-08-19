import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

describe("sidebar panel layout", () => {
  it("orders Output above Input and API with one accessible disclosure each", async () => {
    const html = await source("src/sidebarProvider.ts");
    expect(html).toContain('<section id="input-section" class="input-section">');
    expect(html).toContain('id="input-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true"');
    expect(html.indexOf('id="result-section"')).toBeLessThan(html.indexOf('id="input-section"'));
    expect(html.indexOf('id="input-section"')).toBeLessThan(html.indexOf('id="methods-section"'));
    expect(html).toMatch(/id="input-body" class="collapsible-body input-body"[\s\S]*id="input-shell"[\s\S]*id="attachment-bar"[\s\S]*class="action-row"/);
    expect(html.match(/class="icon-button panel-fullscreen"/g)).toHaveLength(3);
  });

  it("uses the shared mouse and keyboard disclosure behavior", async () => {
    const main = await source("src/webview/main.ts");
    expect(main).toContain('inputHeading: element<HTMLElement>("input-heading")');
    expect(main).toContain('inputBody: element<HTMLElement>("input-body")');
    expect(main).toMatch(/elements\.inputHeading\.addEventListener\("click",[\s\S]*toggleSection\(elements\.inputHeading, elements\.inputBody\)/);
    expect(main).toMatch(/elements\.inputHeading\.addEventListener\("keydown",[\s\S]*event\.key === "Enter" \|\| event\.key === " "[\s\S]*toggleSection\(elements\.inputHeading, elements\.inputBody\)/);
  });

  it("uses exactly Mode, Agent, and Model controls for the input footer", async () => {
    const html = await source("src/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    expect(html).toContain('id="mode-control"');
    expect(html).toContain('id="agent-control"');
    expect(html).toContain('id="model-control"');
    expect(html).not.toContain('id="agent-profile"');
    expect(main).toContain('type InputMode = "agent" | "ask" | "code"');
    expect(main).toContain('editor.setLanguageEnabled(inputMode === "code")');
  });

  it("refreshes Send state when conversation text changes with language services disabled", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    const main = await source("src/webview/main.ts");
    expect(editor).toContain("this.options.onSourceChanged?.();");
    expect(main).toMatch(/onSourceChanged\(\)\s*\{[\s\S]*?updateRunState\(\);/);
  });

  it("keeps the input footer visible while allowing the editor and attachments to shrink", async () => {
    const css = await source("media/styles.css");
    expect(css).toMatch(/\.input-section \{[\s\S]*?--input-editor-height: clamp\(132px, 28vh, 260px\);[\s\S]*?flex: 0 1 auto;[\s\S]*?max-height: 58%;[\s\S]*?overflow: visible;[\s\S]*?\}/);
    expect(css).toMatch(/\.input-panel \{[\s\S]*?height: var\(--input-editor-height\);[\s\S]*?flex: 0 1 var\(--input-editor-height\);/);
    expect(css).toMatch(/\.code-editor \{[\s\S]*?height: 100%;[\s\S]*?min-height: 0;[\s\S]*?\}/);
    expect(css).toMatch(/\.attachment-bar \{[\s\S]*?max-height: 76px;[\s\S]*?overflow: auto;[\s\S]*?\}/);
    expect(css).toMatch(/\.input-section\.section-collapsed,[\s\S]*?\.result-section\.section-collapsed,[\s\S]*?flex: 0 0 auto;/);
    expect(css).toMatch(/\.result-section \{[\s\S]*?flex: 1 1 auto;/);
    expect(css).toMatch(/main\.workspace-fullscreen > \.panel-expanded \{[\s\S]*?max-height: none;/);
  });

  it("supports shared panel fullscreen and stop execution interactions", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    expect(main).toContain('type PanelName = "input" | "result" | "methods"');
    expect(main).toContain('elements.main.classList.add("workspace-fullscreen")');
    expect(main).toMatch(/if \(fullscreenPanel\)[\s\S]*toggleFullscreen\(panelName\);[\s\S]*setSectionOpen\(heading, body, false\);/);
    expect(main).not.toContain('onHeightChanged(height)');
    expect(main).toContain('vscode.postMessage({ type: "stopExecution", turnId: activeTurnId })');
    expect(sidebar).toContain('private activeExecution: { turnId: string; controller: AbortController } | undefined;');
    expect(sidebar).toContain('this.activeExecution?.turnId === request.turnId');
  });
});
