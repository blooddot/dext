import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ customizations: undefined as unknown }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === "colorCustomizations" ? state.customizations : undefined)
    })
  }
}));

import { appearanceColorStyle, dextColorOverrides } from "../src/platform/vscode/appearanceColors.js";

beforeEach(() => { state.customizations = undefined; });

describe("The user's own colours for the Light and Dark palettes", () => {
  it("applies bare entries to both palettes and scoped ones only to their kind", () => {
    const overrides = dextColorOverrides({
      "editor.background": "#000000",
      "sideBar.background": "#111111",
      "[Dark Modern]": { "editor.background": "#000000" },
      "[Light Modern]": { "editor.background": "#ffffff" }
    });
    // A scope is not a colour, so it must not leak into the declarations.
    expect(Object.keys(overrides.dark).sort()).toEqual(["editor.background", "sideBar.background"]);
    expect(overrides.dark["editor.background"]).toBe("#000000");
    expect(overrides.light).toEqual({ "editor.background": "#ffffff", "sideBar.background": "#111111" });
  });

  it("accepts VS Code's own theme ids as well as the picker labels", () => {
    const overrides = dextColorOverrides({
      "[Default Dark Modern]": { "editor.foreground": "#ffffff" },
      "[Default Light Modern]": { "editor.foreground": "#000000" }
    });
    expect(overrides.dark["editor.foreground"]).toBe("#ffffff");
    expect(overrides.light["editor.foreground"]).toBe("#000000");
  });

  it("drops values that would escape the declaration they are baked into", () => {
    const overrides = dextColorOverrides({ "editor.background": "red}", "editor.foreground": 3, "editor.findMatchHighlightBackground": "#0000" });
    expect(overrides.dark).toEqual({ "editor.findMatchHighlightBackground": "#0000" });
  });

  it("bakes the colours behind the palette attribute, so auto keeps the workbench's own", () => {
    state.customizations = { "[Dark Modern]": { "editor.background": "#000000" } };
    expect(appearanceColorStyle()).toBe(
      'body[data-dext-theme="dark"]{--vscode-editor-background:#000000 !important}'
    );
  });

  it("bakes nothing when the user customised no colour", () => {
    expect(appearanceColorStyle()).toBe("");
  });
});
