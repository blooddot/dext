import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPLETION_APIS, COMPLETION_FIELDS } from "../src/core/completionProvider.js";

interface PackageManifest {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    configuration?: {
      properties?: Record<string, {
        type?: string;
        default?: unknown;
        enum?: string[];
        minimum?: number;
        maximum?: number;
        description?: string;
        markdownDescription?: string;
        markdownDeprecationMessage?: string;
        enumDescriptions?: string[];
        properties?: Record<string, {
          type?: string;
          default?: unknown;
          enum?: string[];
          description?: string;
          enumDescriptions?: string[];
        }>;
      }>;
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

  it("binds the everyday conversation commands and scopes stop to a running turn", async () => {
    const keybindings = (await manifest()).contributes?.keybindings ?? [];
    expect(keybindings).toContainEqual({ command: "dext.focus", key: "ctrl+alt+d", mac: "cmd+alt+d" });
    expect(keybindings)
      .toContainEqual({ command: "dext.newConversation", key: "ctrl+alt+n", mac: "cmd+alt+n" });
    // Stop only claims its chord while a turn is running, so it cannot shadow
    // an editor binding the rest of the time.
    expect(keybindings).toContainEqual({
      command: "dext.stopExecution",
      key: "ctrl+alt+.",
      mac: "cmd+alt+.",
      when: "dext.running"
    });
    expect((await manifest()).contributes?.commands)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "dext.stopExecution", title: "Dext: Stop Execution" })
      ]));
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

  it("offers recording a conversation as a workflow only where a file can be written", async () => {
    const value = await manifest();
    const entry = (value.contributes?.menus?.["webview/context"] ?? [])
      .find((item) => item.command === "dext.history.recordWorkflow");
    expect(entry?.when).toContain("webviewSection == 'session' || webviewSection == 'turn'");
    // Writing into `.dext/api` needs a trusted workspace, so the action is not
    // offered where it would only be able to fail.
    expect(entry?.when).toContain("dext.workspaceTrusted");
    const titles = new Map((value.contributes?.commands ?? []).map((item) => [item.command, item.title]));
    expect(titles.get("dext.history.recordWorkflow")).toBe("Record Conversation as Dext Workflow");
  });

  it("configures the completion backend without ever asking for the key in settings", async () => {
    const value = await manifest();
    const properties = value.contributes?.configuration?.properties ?? {};
    // One object setting renders in the Settings UI as an untyped key/value
    // table with an Add Item button: no dropdown, and nowhere to type the URL.
    // Each field is its own setting so the UI can draw a real control for it.
    // The object form stays declared but deprecated: the Settings UI hides it,
    // and a registered key is the only kind Dext is allowed to delete when it
    // migrates the values across.
    expect(properties["dext.completion"]?.markdownDeprecationMessage).toContain("Replaced by");
    expect(properties["dext.completion.endpoint"]).toMatchObject({ type: "string", default: "" });
    expect(properties["dext.completion.model"]).toMatchObject({ type: "string", default: "" });
    expect(properties["dext.completion.ignoreGitignore"]).toMatchObject({ type: "boolean", default: true });
    // Every field the backend reads has to be contributed, or it can only ever
    // hold its default.
    for (const field of COMPLETION_FIELDS) {
      expect(properties).toHaveProperty(`dext.completion.${field}`);
    }
    // Every format the backend can speak has to be offered here too, or the
    // wizard would write a value settings.json rejects.
    const api = properties["dext.completion.api"];
    expect(api?.enum).toEqual([...COMPLETION_APIS]);
    expect(api?.enumDescriptions).toHaveLength(COMPLETION_APIS.length);
    // The provider has to exist before the sidebar is ever opened, or inline
    // completion silently does nothing until something else activates Dext.
    expect(value.activationEvents).toContain("onStartupFinished");
    // A key in settings.json ends up in source control, so there is no box for
    // one; the description says where it goes and links to the command.
    expect(JSON.stringify(properties["dext.completion.apiKey"])).toBe(undefined);
    const enabled = properties["dext.completion.enabled"];
    expect(enabled?.markdownDescription).toContain("secret storage");
    expect(enabled?.markdownDescription).toContain("(command:dext.setCompletionApiKey)");
    expect(enabled?.markdownDescription).toContain("(command:dext.configureCompletionModel)");
    const commands = (value.contributes?.commands ?? []).map((item) => item.command);
    for (const command of [
      "dext.configureCompletionModel",
      "dext.completionMenu",
      "dext.testCompletionModel",
      "dext.setCompletionApiKey",
      "dext.clearCompletionApiKey",
      "dext.toggleCompletion"
    ]) {
      expect(commands).toContain(command);
      expect(value.activationEvents).toContain(`onCommand:${command}`);
    }
  });

  it("exposes every timeout that can cut a turn off", async () => {
    const properties = (await manifest()).contributes?.configuration?.properties ?? {};
    expect(properties["dext.agent.timeoutMs"]).toMatchObject({ type: "integer", default: 600000 });
    expect(properties["dext.aioa.timeoutMs"]).toMatchObject({ type: "integer", default: 3600000 });
    expect(properties["dext.aioa.idleTimeoutMs"]).toMatchObject({ type: "integer", default: 90000 });
    expect(properties["dext.terminal.defaultTimeoutMs"])
      .toMatchObject({ type: "integer", default: 120000 });
    // The terminal ceiling stays a ceiling, so the setting cannot be used to
    // let a runaway command live longer than Dext allows.
    expect(properties["dext.terminal.defaultTimeoutMs"]?.description).toContain("600000");
    // Settings are English only, by convention for this manifest. Every piece of
    // prose counts, not just `description`.
    for (const [name, property] of Object.entries(properties)) {
      expect(JSON.stringify({ name, property })).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("exposes the layout and history limits the UI reads at runtime", async () => {
    const properties = (await manifest()).contributes?.configuration?.properties ?? {};
    expect(properties["dext.apiDirs"]).toMatchObject({ type: "array", default: [] });
    // A configured directory must not be able to take over a project's own API.
    expect(properties["dext.apiDirs"]?.description).toContain("cannot shadow a project API");
    expect(properties["dext.plan.directory"]).toMatchObject({ type: "string", default: ".dext/plans" });
    expect(properties["dext.plan.directory"]?.description).toContain("inside the workspace");
    expect(properties["dext.submitOnEnter"]).toMatchObject({ type: "boolean", default: true });
    expect(properties["dext.submitOnEnter"]?.description).toContain("Shift+Enter");
    expect(properties["dext.diff.defaultView"]).toMatchObject({ type: "string", default: "inline" });
    expect(properties["dext.diff.defaultView"]?.enum).toEqual(["inline", "split"]);
    expect(properties["dext.history.maxTurns"]).toMatchObject({ type: "integer", default: 100 });
    expect(properties["dext.history.maxOutputLength"]).toMatchObject({ type: "integer", default: 200000 });
    // Fan-out width has a ceiling because every branch can start its own process.
    const concurrency = properties["dext.workflow.maxConcurrency"];
    expect(concurrency).toMatchObject({ type: "integer", default: 4, minimum: 1 });
    expect(concurrency?.maximum).toBeLessThanOrEqual(16);
    expect(concurrency?.description).toContain("comprehension");
  });

  it("offers three Agent permission tiers and a trusted-only CLI passthrough", async () => {
    const properties = (await manifest()).contributes?.configuration?.properties ?? {};
    const permission = properties["dext.agentPermission"];
    expect(permission).toMatchObject({ type: "string", default: "workspace-write" });
    expect(permission?.enum).toEqual(["read-only", "workspace-write", "full-access"]);
    // Each tier has to say what it will do before it is picked.
    expect(permission?.enumDescriptions).toHaveLength(3);
    expect(permission?.description).toContain("Ask and Plan are always read-only");
    const passthrough = properties["dext.agentCliArgs"];
    expect(passthrough).toMatchObject({ type: "object", default: {} });
    expect(passthrough?.markdownDescription).toContain("trusted workspace");
    // A passthrough argument must not be a way around the tier.
    expect(passthrough?.markdownDescription).toContain("cannot loosen the permission tier");
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
