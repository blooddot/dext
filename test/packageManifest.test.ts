import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  activationEvents?: string[];
  contributes?: {
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    configuration?: {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
  };
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(resolve("package.json"), "utf8")) as PackageManifest;
}

describe("Dext package manifest", () => {
  it("captures normal editor copy only for nonempty selections when enabled", async () => {
    const value = await manifest();
    expect(value.activationEvents).toContain("onCommand:dext.copySelectionWithContext");
    expect(value.contributes?.keybindings).toContainEqual({
      command: "dext.copySelectionWithContext",
      key: "ctrl+c",
      mac: "cmd+c",
      when: "editorTextFocus && editorHasSelection && config.dext.captureSelectionOnCopy"
    });
  });

  it("enables selection capture by default and explains the native-copy fallback", async () => {
    const setting = (await manifest()).contributes?.configuration?.properties?.["dext.captureSelectionOnCopy"];
    expect(setting).toMatchObject({ type: "boolean", default: true });
    expect(setting?.description).toContain("exact selected text");
    expect(setting?.description).toContain("native copy behavior");
  });

  it("shows workspace trust status beside the API refresh view action", async () => {
    const actions = (await manifest()).contributes?.menus?.["view/title"] ?? [];
    expect(actions).toContainEqual({
      command: "dext.workspaceTrustedStatus",
      when: "view == dext.sidebar && dext.workspaceTrusted",
      group: "navigation@0"
    });
    expect(actions).toContainEqual({
      command: "dext.workspaceUntrustedStatus",
      when: "view == dext.sidebar && !dext.workspaceTrusted",
      group: "navigation@0"
    });
    expect(actions).toContainEqual({
      command: "dext.reloadMethods",
      when: "view == dext.sidebar",
      group: "navigation@1"
    });
  });
});
