import { describe, expect, it, vi } from "vitest";
import { DEXT_APPEARANCE_KEY } from "../src/shared/contracts/appearance.js";
import { DextAppearanceController, type AppearanceMemento } from "../src/platform/vscode/appearance.js";
import { parseDextAppearanceRequest } from "../src/platform/webviewProtocol.js";
import { renderEditorTabHtml } from "../src/platform/editor-tabs/editorTabHtml.js";
import { EditorTabManager, type EditorTabHost, type EditorTabPanelHandle } from "../src/platform/editor-tabs/editorTabManager.js";

class MemoryMemento implements AppearanceMemento {
  readonly values = new Map<string, unknown>();
  updates: unknown[] = [];
  get(section: string, defaultValue?: unknown): unknown {
    return this.values.has(section) ? this.values.get(section) : defaultValue;
  }
  async update(section: string, value: unknown): Promise<void> {
    this.updates.push(value);
    this.values.set(section, value);
  }
}

describe("Dext appearance", () => {
  it("persists one choice and broadcasts it to every webview", async () => {
    const state = new MemoryMemento();
    const controller = new DextAppearanceController(state);
    expect(controller.current).toBe("auto");

    const listener = vi.fn();
    controller.onDidChange(listener);
    await controller.set("paper");

    expect(state.values.get(DEXT_APPEARANCE_KEY)).toBe("paper");
    expect(controller.current).toBe("paper");
    expect(listener).toHaveBeenCalledWith("paper");

    // A reloaded extension keeps the stored choice.
    expect(new DextAppearanceController(state).current).toBe("paper");
  });

  it("ignores unknown values and does not rebroadcast an unchanged choice", async () => {
    const state = new MemoryMemento();
    state.values.set(DEXT_APPEARANCE_KEY, "neon");
    const controller = new DextAppearanceController(state);
    expect(controller.current).toBe("auto");

    const listener = vi.fn();
    controller.onDidChange(listener);
    await controller.set("dim");
    await controller.set("dim");
    await controller.set("neon" as never);

    expect(controller.current).toBe("dim");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual(["dim"]);
  });

  it("only accepts a well-formed appearance request from a webview", () => {
    expect(parseDextAppearanceRequest({ type: "setDextAppearance", theme: "paper" })).toBe("paper");
    expect(parseDextAppearanceRequest({ type: "setDextAppearance", theme: "auto" })).toBe("auto");
    expect(parseDextAppearanceRequest({ type: "setDextAppearance", theme: "dim" })).toBe("dim");
    expect(parseDextAppearanceRequest({ type: "setDextAppearance", theme: "neon" })).toBeUndefined();
    expect(parseDextAppearanceRequest({ type: "other", theme: "paper" })).toBeUndefined();
    expect(parseDextAppearanceRequest(undefined)).toBeUndefined();
  });

  it("paints the persisted choice into an editor tab shell without an in-page control", () => {
    const html = renderEditorTabHtml("<div data-project-page></div>", "https://webview.test/editorTabs.css", "https://webview.test", {
      scriptUri: "https://webview.test/project.js",
      appearance: {
        theme: "dim",
        stylesheetUri: "https://webview.test/appearance.css",
        scriptUri: "https://webview.test/appearance.js"
      }
    });
    expect(html).toContain('<body class="editor-tab" data-dext-theme="dim">');
    // The theme is chosen from the sidebar's view title; editor pages only sync.
    expect(html).not.toContain("dext-topbar");
    expect(html).not.toContain("data-dext-appearance");
    expect(html.indexOf("appearance.css")).toBeGreaterThan(html.indexOf("editorTabs.css"));
    // The sync bundle must still load before the page bundle.
    expect(html.indexOf("appearance.js")).toBeLessThan(html.indexOf("project.js"));
    const nonce = html.match(/<script nonce="([^"]+)" src="https:\/\/webview.test\/appearance.js"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
  });

  it("allows the codicon font only when a page asks for its stylesheet", () => {
    const html = renderEditorTabHtml("<div></div>", "https://webview.test/editorTabs.css", "https://webview.test", {
      codiconStylesheetUri: "https://webview.test/codicon.css"
    });
    expect(html).toContain('<link rel="stylesheet" href="https://webview.test/codicon.css">');
    // Without font-src the CSP would block codicon.ttf and every glyph renders empty.
    expect(html).toContain("font-src https://webview.test;");
    expect(renderEditorTabHtml("<div></div>", "https://webview.test/editorTabs.css", "https://webview.test"))
      .not.toContain("font-src");
  });

  it("broadcasts appearance changes to every open editor tab", () => {
    const panels: Array<EditorTabPanelHandle & { posted: unknown[] }> = [];
    const host: EditorTabHost = {
      createPanel() {
        const panel = {
          posted: [] as unknown[],
          reveal: vi.fn(),
          dispose: vi.fn(),
          postMessage(message: unknown) { panel.posted.push(message); }
        };
        panels.push(panel);
        return panel;
      }
    };
    const manager = new EditorTabManager(host);
    manager.open({ key: "dext.editor:history", kind: "history", viewType: "dext.history", title: "History" });
    manager.open({ key: "dext.editor:api", kind: "api", viewType: "dext.api", title: "API" });

    manager.postAll({ type: "dextAppearance", theme: "paper" });

    expect(panels.map((panel) => panel.posted)).toEqual([
      [{ type: "dextAppearance", theme: "paper" }],
      [{ type: "dextAppearance", theme: "paper" }]
    ]);
  });
});
