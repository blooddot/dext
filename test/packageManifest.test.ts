import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
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

  it("carries the whole sidebar toolbar in the view title bar", async () => {
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
    // The most used actions come first so VS Code keeps them out of the
    // overflow menu as the sidebar narrows.
    expect(actions
      .filter((action) => action.when === "view == dext.sidebar")
      .map((action) => [action.command, action.group])
    ).toEqual([
      ["dext.newConversation", "navigation@1"],
      ["dext.openHistory", "navigation@2"],
      ["dext.viewApis", "navigation@3"]
    ]);
    // Reloading APIs belongs with the API list it refreshes, and History is the
    // single place that reopens a past conversation.
    expect(actions.map((action) => action.command)).not.toContain("dext.reloadMethods");
    expect(actions.map((action) => action.command)).not.toContain("dext.showConversations");
    expect((await manifest()).contributes?.commands)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "dext.reloadMethods" })
      ]));
  });

  it("drives conversation actions from the History webview context menu", async () => {
    const value = await manifest();
    const menu = value.contributes?.menus?.["webview/context"] ?? [];
    const palette = value.contributes?.menus?.commandPalette ?? [];
    expect(menu.filter((item) => item.when?.includes("webviewSection == 'turn'")).map((item) => item.command))
      .toEqual(expect.arrayContaining(["dext.history.forkFromTurn", "dext.history.editTurnInput"]));
    for (const command of [
      "dext.history.continueConversation",
      "dext.history.forkConversation",
      "dext.history.copyConversation",
      "dext.history.deleteConversation"
    ]) {
      const item = menu.find((entry) => entry.command === command);
      expect(item?.when).toContain("webviewId == 'dext.history'");
      // Session actions stay reachable when the click lands on a single turn.
      expect(item?.when).toContain("webviewSection == 'session' || webviewSection == 'turn'");
    }
    // Every one of them needs the right-clicked element to supply its target.
    for (const item of menu) {
      expect(palette).toContainEqual({ command: item.command, when: "false" });
    }
  });

  it("toggles history ordering and the favorites filter from the panel title bar", async () => {
    const menu = (await manifest()).contributes?.menus?.["editor/title"] ?? [];
    const entry = (command: string): string | undefined => menu.find((item) => item.command === command)?.when;
    // Only one half of each pair is ever visible, so the button always offers
    // the state the panel is not already in.
    expect(entry("dext.history.showFavoritesOnly"))
      .toBe("activeWebviewPanelId == 'dext.history' && !dext.historyFavoritesOnly");
    expect(entry("dext.history.showAllConversations"))
      .toBe("activeWebviewPanelId == 'dext.history' && dext.historyFavoritesOnly");
    expect(entry("dext.history.showOldestFirst"))
      .toBe("activeWebviewPanelId == 'dext.history' && dext.historyNewestFirst");
    expect(entry("dext.history.showNewestFirst"))
      .toBe("activeWebviewPanelId == 'dext.history' && !dext.historyNewestFirst");
  });

  it("pins conversation tabs and favorites history entries from their context menus", async () => {
    const menu = (await manifest()).contributes?.menus?.["webview/context"] ?? [];
    const entry = (command: string): string | undefined => menu.find((item) => item.command === command)?.when;
    expect(entry("dext.tab.pinConversation"))
      .toBe("webviewId == 'dext.sidebar' && webviewSection == 'conversationTab' && !dextTabPinned");
    expect(entry("dext.tab.unpinConversation"))
      .toBe("webviewId == 'dext.sidebar' && webviewSection == 'conversationTab' && dextTabPinned");
    expect(entry("dext.tab.closeConversation"))
      .toBe("webviewId == 'dext.sidebar' && webviewSection == 'conversationTab'");
    expect(entry("dext.history.addFavorite")).toContain("&& !dextFavorite");
    expect(entry("dext.history.removeFavorite")).toContain("&& dextFavorite");
  });

  it("offers rename from both the conversation tab and the History entry", async () => {
    const value = await manifest();
    const menu = value.contributes?.menus?.["webview/context"] ?? [];
    const titles = new Map((value.contributes?.commands ?? []).map((item) => [item.command, item.title]));
    expect(menu.find((item) => item.command === "dext.tab.renameConversation")?.when)
      .toBe("webviewId == 'dext.sidebar' && webviewSection == 'conversationTab'");
    expect(menu.find((item) => item.command === "dext.history.renameConversation")?.when)
      .toContain("webviewId == 'dext.history'");
    expect(titles.get("dext.tab.renameConversation")).toBe("Rename");
    expect(titles.get("dext.history.renameConversation")).toBe("Rename Conversation");
  });

  it("contributes secure HTTP MCP settings and credential commands", async () => {
    const value = await manifest();
    expect(value.activationEvents).toContain("onCommand:dext.setMcpAccessToken");
    expect(value.activationEvents).toContain("onCommand:dext.clearMcpAccessToken");
    expect(value.activationEvents).toContain("onCommand:dext.verifyMcpServer");
    expect(value.contributes?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "dext.setMcpAccessToken", title: "Dext: Set MCP Access Token" }),
      expect.objectContaining({ command: "dext.clearMcpAccessToken", title: "Dext: Clear MCP Access Token" }),
      expect.objectContaining({ command: "dext.verifyMcpServer", title: "Dext: Verify MCP Server" })
    ]));
    const setting = (await manifest()).contributes?.configuration?.properties?.["dext.mcpServers"];
    expect(setting?.description).toContain("SecretStorage");
  });
});
