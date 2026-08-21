import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

describe("sidebar panel layout", () => {
  it("keeps API out of the main flow and exposes it from the view title bar", async () => {
    const html = await source("src/sidebarProvider.ts");
    const manifest = await source("package.json");
    expect(html).toContain('<section id="input-section" class="input-section">');
    expect(html).toContain('id="input-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true"');
    expect(html).not.toContain('id="view-methods"');
    expect(manifest).toContain('"command": "dext.viewApis"');
    expect(html).toContain('viewApis(): void {\n    this.postWhenReady({ type: "openMethods" });');
    expect(html).toContain('<dialog id="methods-dialog" class="methods-dialog"');
    expect(html).toContain('id="close-methods"');
    expect(html).not.toContain('id="methods-section"');
    expect(html.indexOf('id="result-section"')).toBeLessThan(html.indexOf('id="input-section"'));
    expect(html).toMatch(/id="input-body" class="collapsible-body input-body"[\s\S]*id="input-shell"[\s\S]*id="attachment-bar"[\s\S]*class="action-row"/);
    expect(html.match(/class="icon-button panel-fullscreen"/g)).toHaveLength(2);
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
    const editor = await source("src/webview/codeEditor.ts");
    const css = await source("media/styles.css");
    expect(html).toContain('id="mode-control"');
    expect(html).toContain('id="mode-control-icon"');
    expect(html).toContain('id="agent-control"');
    expect(html).toContain('id="model-control"');
    expect(html).toContain('id="model-submenu" class="composer-popover composer-model-popover composer-model-submenu"');
    expect(html).not.toContain('id="agent-profile"');
    expect(main).toContain('type InputMode = "agent" | "ask" | "code"');
    expect(main).toContain('editor.setLanguageEnabled(inputMode === "code")');
    expect(main).toContain('elements.inputShell.classList.toggle("conversation-mode", !codeMode)');
    expect(main).toContain('elements.inputSection.dataset.mode = inputMode');
    expect(main).toContain('elements.modeControlIcon.className = `codicon ${modeIcon[inputMode]}`');
    expect(main).toContain('pendingDropPosition = undefined');
    expect(editor).toContain('this.lineWrapping.reconfigure(enabled ? [] : EditorView.lineWrapping)');
    expect(css).toContain('.input-shell.conversation-mode .cm-gutters');
    expect(css).toContain('.input-section[data-mode="ask"] #mode-control');
    expect(css).toContain('.input-section[data-mode="code"] #mode-control');
    expect(css).toMatch(/\.composer-control-label \{[\s\S]*?display: none;/);
    expect(css).toMatch(/#model-control \{[\s\S]*?background: transparent;/);
    expect(css).not.toContain('.input-section[data-mode="ask"] .composer-menu:has(#agent-control)');
    expect(css).not.toContain('.input-section[data-mode="code"] .composer-menu:has(#agent-control)');
  });

  it("switches conversations through editor-style tabs and keeps input errors out of Output", async () => {
    const html = await source("src/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const manifest = await source("package.json");
    const css = await source("media/styles.css");
    // The old two-row header is gone: the toolbar lives in VS Code's view
    // title bar and the only webview chrome left is the tab strip.
    expect(html).not.toContain('class="chat-header"');
    expect(css).not.toContain(".chat-header");
    expect(html).toContain('<nav id="conversation-tabs" class="conversation-tabs" role="tablist"');
    expect(css).toMatch(/^\.app-shell \{[\s\S]*?flex-direction: column;/m);
    expect(css).toMatch(/^main \{\n {2}flex: 1 1 auto;/m);
    expect(css).toMatch(/\.conversation-tab \{[\s\S]*?max-width: 190px;[\s\S]*?\}/);
    expect(main).toMatch(/function renderConversations[\s\S]*?conversation-tab-label[\s\S]*?conversation-tab-close/);
    expect(main).toMatch(/function selectConversation[\s\S]*?type: "selectConversation"/);
    expect(main).toMatch(/function closeConversation[\s\S]*?type: "closeConversation"/);
    expect(manifest).toContain('"command": "dext.newConversation"');
    expect(html).toMatch(/async openConversation\(session: DextHistorySession\)[\s\S]*?activateConversation\(existing\)/);
    expect(html).toContain('id="input-error" class="input-error"');
    expect(main).toMatch(/function renderInputError[\s\S]*elements\.inputError\.hidden = false/);
    expect(main).toMatch(/message\.type === "error"[\s\S]*renderInputError\(message\.message\)/);
    expect(main).not.toContain("Code mode only");
  });

  it("closes a conversation tab without dropping the conversation from history", async () => {
    const sidebar = await source("src/sidebarProvider.ts");
    const close = sidebar.slice(
      sidebar.indexOf("private async closeConversation"),
      sidebar.indexOf("constructor(")
    );
    expect(sidebar).toContain("private openConversations: string[]");
    expect(close).toContain("this.openConversations = this.openConversations.filter((id) => id !== sessionId)");
    expect(close).toContain("const neighbour = remaining[index] ?? remaining[index - 1]");
    // The session store backs history, so closing a tab must never touch it.
    expect(close).not.toContain("this.sessions.delete");
    expect(sidebar).toMatch(/type: "conversations",[\s\S]*?this\.orderedConversations\(\)\.flatMap/);
  });

  it("pins a conversation tab to the front of the strip and back onto the next reload", async () => {
    const sidebar = await source("src/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(sidebar).toMatch(/private orderedConversations\(\): string\[\][\s\S]*?this\.preferences\.pinned\(\)\.filter\(\(id\) => this\.openConversations\.includes\(id\)\)/);
    // Only pinned conversations survive a reload; the rest start from the last
    // conversation that was worked on.
    expect(sidebar).toMatch(/hydrateSessions\(\): void \{[\s\S]*?const pinned = this\.preferences\.pinned\(\)\.filter\(\(id\) => this\.sessions\.has\(id\)\);[\s\S]*?new Set\(\[\.\.\.pinned, this\.activeSession\.id\]\)/);
    // Closing is an explicit dismissal, so it releases the pin as well.
    expect(sidebar).toMatch(/private async closeConversation[\s\S]*?if \(this\.preferences\.isPinned\(sessionId\)\) await this\.preferences\.setPinned\(sessionId, false\)/);
    expect(main).toMatch(/tab\.dataset\.vscodeContext = JSON\.stringify\(\{[\s\S]*?webviewSection: "conversationTab"[\s\S]*?dextTabPinned: conversation\.pinned/);
    expect(main).toMatch(/conversation\.pinned \? "conversation-tab-pin" : "conversation-tab-close"/);
    expect(main).toMatch(/function pinConversation[\s\S]*?type: "pinConversation"/);
    expect(css).toMatch(/\.conversation-tab\.pinned \{[\s\S]*?max-width: 128px;/);
  });

  it("renders text output through a safe Markdown surface with code token styles", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(main).toContain('const markdown = new MarkdownIt({');
    expect(main).toContain('html: false');
    expect(main).toMatch(/function copyableText[\s\S]*?className = "markdown-body"[\s\S]*?markdown\.render\(content\)/);
    expect(css).toContain(".markdown-body pre");
    expect(css).toContain(".tok-keyword");
  });

  it("refreshes Send state when conversation text changes with language services disabled", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    const main = await source("src/webview/main.ts");
    expect(editor).toContain("this.options.onSourceChanged?.();");
    expect(main).toMatch(/onSourceChanged\(\)\s*\{[\s\S]*?updateRunState\(\);/);
  });

  it("keeps the composer visible while allowing the history, editor, and attachments to shrink", async () => {
    const css = await source("media/styles.css");
    expect(css).toMatch(/\.input-section \{[\s\S]*?--input-editor-height: clamp\(112px, 24vh, 240px\);[\s\S]*?flex: 0 0 auto;[\s\S]*?max-height: min\(58%, 360px\);[\s\S]*?overflow: hidden;[\s\S]*?\}/);
    expect(css).toMatch(/\.input-panel \{[\s\S]*?height: var\(--input-editor-height\);[\s\S]*?flex: 1 1 var\(--input-editor-height\);/);
    expect(css).toMatch(/\.code-editor \{[\s\S]*?height: 100%;[\s\S]*?min-height: 0;[\s\S]*?\}/);
    expect(css).toMatch(/\.attachment-bar \{[\s\S]*?max-height: 76px;[\s\S]*?overflow: auto;[\s\S]*?\}/);
    expect(css).toMatch(/\.input-section\.section-collapsed,[\s\S]*?\.result-section\.section-collapsed \{[\s\S]*?flex: 0 0 auto;/);
    expect(css).toMatch(/\.result-section \{[\s\S]*?flex: 1 1 auto;/);
    expect(css).toMatch(/@media \(max-height: 480px\)[\s\S]*?\.input-section \{[\s\S]*?--input-editor-height: clamp\(56px, 20vh, 96px\);/);
    expect(css).toMatch(/main\.workspace-fullscreen > \.panel-expanded \{[\s\S]*?max-height: none;/);
  });

  it("clears submitted text without deleting image attachments", async () => {
    const main = await source("src/webview/main.ts");
    expect(main).toMatch(/vscode\.postMessage\(\{ type: "executeInput", mode: inputMode, source \}\);[\s\S]*?clearSubmittedInput\(\);/);
    expect(main).toMatch(/function clearSubmittedInput\(\): void \{[\s\S]*?editor\.setValue\(""\);/);
    expect(main).not.toContain("function clearImageAttachments");
    expect(main).toMatch(/image-attachment-remove[\s\S]*?type: "deleteImageAttachment"/);
  });

  it("defers temporary image deletion until the running turn has consumed its input", async () => {
    const sidebar = await source("src/sidebarProvider.ts");
    expect(sidebar).toContain("private readonly pendingAttachmentDeletes = new Set<string>();");
    expect(sidebar).toMatch(/case "deleteImageAttachment":[\s\S]*?if \(this\.running\) this\.pendingAttachmentDeletes\.add\(request\.relativePath\);/);
    expect(sidebar).toMatch(/this\.running = false;[\s\S]*?await this\.flushAttachmentDeletes\(\);/);
  });

  it("keeps live trace entries in event arrival order and folds consecutive commands together", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(main).toContain("const agentEventItems = new Map<string, HTMLElement>();");
    expect(main).toContain("let agentToolGroup: AgentToolGroup | undefined;");
    expect(main).toMatch(/function renderAgentEvent[\s\S]*?if \(event\.phase === "tool"\)[\s\S]*?createAgentToolCommand\(event, group\?\.body \?\? panel, group\)/);
    expect(main).toMatch(/function renderAgentEvent[\s\S]*?agentToolGroup = undefined;[\s\S]*?panel\.append\(item\);/);
    expect(main).toMatch(/function updateAgentToolGroupLabel[\s\S]*?Ran \$\{count\} command/);
    expect(main).toMatch(/function createAgentToolCommand[\s\S]*?document\.createElement\("details"\)[\s\S]*?terminalText\(raw\)/);
    expect(main).toMatch(/function renderAgentEvent[\s\S]*?body\.innerHTML = markdown\.render\(raw\)/);
    expect(css).toMatch(/\.terminal-output \{[\s\S]*?max-height: 360px;[\s\S]*?overflow: auto;[\s\S]*?white-space: pre-wrap;/);
    expect(main).not.toContain("const order = { reasoning: 0, work: 1, files: 2, tool: 3 }");
  });

  it("reproduces the grouping an agent reports and falls back to adjacency otherwise", async () => {
    const main = await source("src/webview/main.ts");
    expect(main).toContain("const agentToolGroups = new Map<string, AgentToolGroup>();");
    // A named group is reused wherever it already sits, so a later step of the
    // same group is never split off into a new one.
    expect(main).toMatch(/if \(event\.groupId\) \{[\s\S]*?agentToolGroups\.get\(event\.groupId\)[\s\S]*?agentToolGroups\.set\(event\.groupId, group\);/);
    expect(main).toMatch(/if \(event\.solo\) \{\s*agentToolGroup = undefined;\s*return undefined;/);
    expect(main).toMatch(/const trailingGroup = \(group: AgentToolGroup \| undefined\): AgentToolGroup \| undefined =>[\s\S]*?group\.disclosure === panel\.lastElementChild \? group : undefined;/);
    expect(main).toMatch(/const group = trailingGroup\(agentToolGroup\) \?\? createAgentToolGroup\(\);/);
    expect(main).toMatch(/function updateAgentToolGroupLabel[\s\S]*?if \(group\.labelText\)/);
    // Replacing an earlier message must not split the run of commands below it.
    expect(main).toMatch(/if \(!item\) \{\s*\/\/[\s\S]*?agentToolGroup = undefined;/);
    expect(main).not.toMatch(/agentToolGroup = undefined;\s*const panel = agentStreamPanel\(\);/);
    expect(main).toMatch(/function resetAgentTrace[\s\S]*?agentToolGroups\.clear\(\);/);
  });

  it("renders trace prose in the UI font and command output as a code panel", async () => {
    const css = await source("media/styles.css");
    const main = await source("src/webview/main.ts");
    expect(css).toMatch(/\.agent-trace-message > \.agent-stream-text \{[\s\S]*?font-family: var\(--vscode-font-family\);[\s\S]*?white-space: normal;/);
    expect(css).toMatch(/\.agent-trace-command-body \{[\s\S]*?border: 1px solid var\(--vscode-widget-border\);/);
    expect(main).toContain('body.className = "terminal-output agent-trace-command-body";');
    expect(main).toMatch(/summary\.append\(toolGlyph\(event\.toolKind\), summaryLabel, chevron\)/);
  });

  it("keeps the model category menu visible beside its option submenu", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(main).toContain('modelSubmenu: element<HTMLElement>("model-submenu")');
    expect(main).toMatch(/renderModelMenu[\s\S]*elements\.modelSubmenu\.hidden = true/);
    expect(main).toMatch(/renderModelChoices\(elements\.modelSubmenu/);
    expect(css).toMatch(/\.composer-menu:last-child \.composer-model-submenu \{[\s\S]*?right: auto;[\s\S]*?bottom: 34px;[\s\S]*?left: calc\(100% \+ 4px\);/);
    expect(css).toMatch(/\.composer-menu:last-child \.composer-model-submenu\[data-submenu-side="left"\] \{[\s\S]*?right: calc\(var\(--composer-model-menu-width\) \+ 4px\);[\s\S]*?left: auto;/);
    expect(main).toMatch(/function positionModelSubmenu\(\): void \{[\s\S]*?fitsRight[\s\S]*?fitsLeft[\s\S]*?modelSubmenu\.dataset\.submenuSide/);
    expect(main).not.toMatch(/button\.addEventListener\("mouseenter"[\s\S]*renderModelChoices\(elements\.modelSubmenu/);
    expect(css).toMatch(/\.input-section:has\(\.composer-popover:not\(\[hidden\]\)\),[\s\S]*?\.input-panel \{[\s\S]*?overflow: visible;/);
  });

  it("does not reopen Output after a user folds it during result updates", async () => {
    const main = await source("src/webview/main.ts");
    const renderResult = main.slice(main.indexOf("function renderResult"), main.indexOf("function renderError"));
    const renderError = main.slice(main.indexOf("function renderError"), main.indexOf("function agentStreamPanel"));
    const renderAgentEvent = main.slice(main.indexOf("function renderAgentEvent"), main.indexOf("function renderAgentFileChanges"));
    expect(renderResult).not.toContain("setSectionOpen(elements.resultHeading, elements.resultBody, true)");
    expect(renderError).not.toContain("setSectionOpen(elements.resultHeading, elements.resultBody, true)");
    expect(renderAgentEvent).not.toContain("setSectionOpen(elements.resultHeading, elements.resultBody, true)");
  });

  it("supports shared panel fullscreen and stop execution interactions", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    expect(main).toContain('type PanelName = "input" | "result"');
    expect(main).toContain('elements.main.classList.add("workspace-fullscreen")');
    expect(main).toMatch(/if \(fullscreenPanel\)[\s\S]*toggleFullscreen\(panelName\);[\s\S]*setSectionOpen\(heading, body, false\);/);
    expect(main).not.toContain('onHeightChanged(height)');
    expect(main).toContain('vscode.postMessage({ type: "stopExecution", turnId: activeTurnId })');
    expect(sidebar).toContain('private activeExecution: { turnId: string; controller: AbortController } | undefined;');
    expect(sidebar).toContain('this.activeExecution?.turnId === request.turnId');
  });

  it("opens the complete API list in a dialog and keeps method insertion intact", async () => {
    const html = await source("src/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(main).toMatch(/function openMethodsDialog[\s\S]*?methodsDialog\.showModal\(\)/);
    expect(main).toMatch(/function closeMethodsDialog[\s\S]*?methodsDialog\.close\(\)/);
    expect(html).toContain('id="reload-methods"');
    expect(main).toMatch(/elements\.reloadMethods\.addEventListener\("click"[\s\S]*?type: "reload"/);
    expect(main).toMatch(/function setMethodsReloading[\s\S]*?codicon-modifier-spin/);
    expect(main).toMatch(/row\.addEventListener\("click", \(\) => \{[\s\S]*?editor\.insertInvocation[\s\S]*?closeMethodsDialog\(\)/);
    expect(css).toContain('.methods-dialog {');
    expect(css).toContain('.methods-dialog-body {');
  });
});
