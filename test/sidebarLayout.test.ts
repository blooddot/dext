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
    expect(main).toContain('const input = outputTurnSection("Input", true);');
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
    expect(main).toContain('type InputMode = "agent" | "ask" | "plan" | "code"');
    expect(main).toContain('editor.setLanguageEnabled(inputMode === "code")');
    expect(main).toContain('elements.inputShell.classList.toggle("conversation-mode", !codeMode)');
    expect(main).toContain('elements.inputSection.dataset.mode = inputMode');
    expect(main).toContain('elements.modeControlIcon.className = `codicon ${modeIcon[inputMode]}`');
    expect(main).toContain('pendingDropPosition = undefined');
    expect(editor).toContain('this.lineWrapping.reconfigure(enabled ? [] : EditorView.lineWrapping)');
    expect(css).toContain('.input-shell.conversation-mode .cm-gutters');
    expect(css).toContain('.input-section[data-mode="ask"] #mode-control');
    expect(css).toContain('.input-section[data-mode="plan"] #mode-control');
    expect(css).toContain('.input-section[data-mode="code"] #mode-control');
    expect(css).toMatch(/\.composer-control-label \{[\s\S]*?display: none;/);
    expect(css).toMatch(/#model-control \{[\s\S]*?background: transparent;/);
    expect(css).not.toContain('.input-section[data-mode="ask"] .composer-menu:has(#agent-control)');
    expect(css).not.toContain('.input-section[data-mode="code"] .composer-menu:has(#agent-control)');
  });

  it("offers Plan beside Agent, Ask, and Code and lands its result as a document", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    const application = await source("src/application.ts");
    const history = await source("src/historyRender.ts");
    const builtins = await source("src/core/builtins.ts");
    expect(main).toMatch(/renderComposerMenu\(elements\.modeMenu, \[[\s\S]*?\["plan", "Plan", "codicon-checklist"\]/);
    expect(main).toContain('plan: "Plan"');
    // A plan turn ends in a file, so the result offers the file and the handoff.
    expect(main).toMatch(/if \(result\.kind === "chat" && result\.planPath\) fragment\.append\(planActions\(result\.planPath\)\)/);
    expect(main).toMatch(/function planActions[\s\S]*?type: "openFileReference", reference: planPath/);
    expect(main).toMatch(/function planActions[\s\S]*?type: "buildPlan", planPath/);
    expect(builtins).toMatch(/id: "plan",\s*title: "Plan",/);
    expect(application).toMatch(/mode === "plan" \? await this\.savePlan\(input, response\) : response/);
    expect(application).toMatch(/private async savePlan[\s\S]*?if \(!this\.workspaceTrusted \|\| !this\.workspaceUri\) return response/);
    expect(application).toMatch(/private async savePlan[\s\S]*?planPath \}/);
    // Building re-reads the file so edits made in the editor are what runs.
    expect(sidebar).toMatch(/private async buildPlan[\s\S]*?vscode\.workspace\.fs\.readFile\(target\)/);
    expect(sidebar).toMatch(/private async buildPlan[\s\S]*?isTrustedLocalWorkspace\(\)/);
    expect(sidebar).toMatch(/private async buildPlan[\s\S]*?planPathSegments\(planPath\)/);
    expect(sidebar).toMatch(/private async buildPlan[\s\S]*?await this\.run\("agent", \[/);
    // The mode switch must not wipe the agent, model, and effort choices.
    expect(sidebar).toContain('this.application.setAgentSelection({ ...this.application.state().agentSelection, mode: "agent" });');
    // History replays the document link but not the handoff button.
    expect(history).toMatch(/result\.kind === "chat" && result\.planPath/);
    expect(history).not.toContain('type: "buildPlan"');
  });

  it("hands the webview the settings it renders with instead of guessing", async () => {
    const main = await source("src/webview/main.ts");
    const application = await source("src/application.ts");
    const extension = await source("src/extension.ts");
    expect(application).toMatch(/private webviewSettings[\s\S]*?diffView: diffView === "split" \? "split" : "inline"/);
    expect(application).toMatch(/private webviewSettings[\s\S]*?submitOnEnter: configuration\.get<boolean>\("submitOnEnter", true\) !== false/);
    expect(main).toMatch(/if \(state\.settings\) \{[\s\S]*?defaultDiffMode = state\.settings\.diffView;[\s\S]*?editor\.setSubmitOnEnter\(state\.settings\.submitOnEnter\)/);
    // A new file change has to open in the configured layout, not always inline.
    expect(main).toContain("view.dataset.diffView = defaultDiffMode;");
    expect(main).toContain('button.className = `diff-mode-button${mode === defaultDiffMode ? " active" : ""}`');
    // A new API directory changes the registered API set, so it needs a reload.
    expect(extension).toMatch(/event\.affectsConfiguration\("dext\.apiDirs"\)[\s\S]*?await application\.reload\(\)/);
    expect(extension).toMatch(/event\.affectsConfiguration\("dext\.diff\.defaultView"\)[\s\S]*?await sidebar\.refresh\(\)/);
    expect(application).toMatch(/private apiDirectories[\s\S]*?isAbsolute\(value\)/);
  });

  it("lays concurrent comprehension branches out beside one another", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    const application = await source("src/application.ts");
    // Branches ran at the same time, so consecutive branch steps collect into one
    // container instead of reading as a sequence.
    expect(main).toMatch(/if \(step\.branch === undefined\) \{[\s\S]*?fanOut = undefined;/);
    expect(main).toContain('fanOut.className = "fan-out"');
    expect(main).toContain('item.classList.add("fan-out-branch")');
    expect(main).toContain("item.dataset.branch = String(step.branch + 1)");
    expect(css).toContain(".fan-out {");
    expect(css).toContain('content: "Branch " attr(data-branch)');
    // A narrow sidebar has to fall back to one column rather than squeeze.
    expect(css).toMatch(/\.fan-out \{[\s\S]*?grid-template-columns: repeat\(auto-fit, minmax\(/);
    expect(application).toContain('this.workflowRuntime.setMaxConcurrency(positive("workflow.maxConcurrency"');
  });

  it("shows the permission tier only for Agent mode and reviews its patch in place", async () => {
    const html = await source("src/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    const manifest = await source("package.json");
    const css = await source("media/styles.css");
    expect(html).toContain('id="permission-control"');
    expect(html).toContain('id="permission-menu-shell"');
    // Ask and Plan are read-only by definition, so the control is hidden rather
    // than shown disabled.
    expect(main).toContain('elements.permissionMenuShell.hidden = inputMode !== "agent"');
    expect(main).toMatch(/renderComposerMenu\(elements\.permissionMenu, \[[\s\S]*?"full-access"/);
    expect(main).toContain('permission: change.permission ?? selection?.permission ?? agentPermission');
    expect(manifest).toContain('"dext.agentPermission"');
    expect(manifest).toContain('"dext.agentCliArgs"');
    // The host holds the patch, so the buttons only appear when it says so.
    expect(main).toMatch(/renderResult\(message\.response, message\.reviewPatch \? message\.turnId : undefined\)/);
    expect(main).toMatch(/function patchReviewActions[\s\S]*?type: "resolvePatch", turnId, uris: \[\.\.\.uris\], accept/);
    expect(main).toMatch(/function applyPatchResolution[\s\S]*?if \(status === "conflict"\)[\s\S]*?button\.disabled = false/);
    expect(sidebar).toMatch(/function unappliedPatch[\s\S]*?argument\.name === "apply" && argument\.value !== false/);
    expect(sidebar).toMatch(/private async resolvePatch[\s\S]*?this\.pendingPatches\.get\(turnId\)/);
    expect(sidebar).toMatch(/private async resolvePatch[\s\S]*?applyPatchHandler\(\{/);
    // A conflict leaves the entry pending so it can be reviewed again.
    expect(sidebar).toMatch(/if \(result\.status === "applied" \|\| result\.status === "unchanged"\) \{\s*this\.forgetResolvedChanges/);
    expect(css).toContain(".patch-review-action.accept");
    expect(css).toContain(".agent-file-change.patch-conflict");
  });

  it("colors Send with the accent of the mode it will run in", async () => {
    const css = await source("media/styles.css");
    // Agent is the plain default; the other modes retint the same two
    // properties, which both the mode control and Send read.
    expect(css).toMatch(/\.input-section \{[\s\S]*?--composer-accent: var\(--vscode-button-background\);[\s\S]*?--composer-accent-foreground: var\(--vscode-button-foreground\);/);
    expect(css).toMatch(/\.input-section\[data-mode="ask"\] \{\n {2}--composer-accent: var\(--vscode-terminal-ansiGreen/);
    expect(css).toMatch(/\.input-section\[data-mode="plan"\] \{\n {2}--composer-accent: var\(--vscode-terminal-ansiYellow/);
    expect(css).toMatch(/\.input-section\[data-mode="code"\] \{\n {2}--composer-accent: var\(--vscode-terminal-ansiCyan/);
    expect(css).toMatch(/#run \{[\s\S]*?color: var\(--composer-accent-foreground, var\(--vscode-button-foreground\)\);[\s\S]*?background: var\(--composer-accent, var\(--vscode-button-background\)\);/);
    expect(css).toMatch(/#run:hover:not\(:disabled\) \{[\s\S]*?color-mix\([\s\S]*?var\(--composer-accent/);
    // The mode control reads the same accent rather than repeating the colors.
    expect(css).toMatch(/\.input-section\[data-mode="code"\] #mode-control \{[\s\S]*?border-color: color-mix\(in srgb, var\(--composer-accent\) 68%[\s\S]*?color: var\(--composer-accent\);[\s\S]*?background: color-mix\(in srgb, var\(--composer-accent\) 14%/);
    expect(css).toMatch(/\.input-section\[data-mode="code"\] #mode-control:focus-visible \{[\s\S]*?outline: 1px solid var\(--composer-accent\);/);
    expect(css).not.toMatch(/\.input-section\[data-mode="(?:ask|plan|code)"\] #mode-control \{[\s\S]*?border-color: color-mix\(in srgb, var\(--vscode-focusBorder\)/);
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

  it("offers the @ file picker in every mode and inserts the same chip as a drop", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    const picker = editor.slice(
      editor.indexOf("private async fileCompletions"),
      editor.indexOf("private async completions")
    );
    // Chat modes switch the language service off, so this source must not be
    // gated on it the way completions() is.
    expect(picker).not.toContain("this.languageEnabled");
    expect(editor).toMatch(/override: \[\s*\(context\) => this\.fileCompletions\(context\),\s*\(context\) => this\.completions\(context\)/);
    expect(editor).toMatch(/private async completions[\s\S]*?if \(!this\.languageEnabled\) return null;/);
    expect(picker).toContain("context.matchBefore(/@[^\\s@#\"'`(){}[\\],]*/)");
    // An email address must not open the picker.
    expect(picker).toContain("if (/[\\p{L}\\p{N}_.+-]/u.test(source[token.from - 1] ?? \"\")) return null;");
    expect(picker).toContain("filter: false");
    expect(picker).toContain("const insert = `@${path} `;");
    expect(sidebar).toMatch(/case "searchFiles":[\s\S]*?rankFileMatches\(\s*await this\.workspaceFileIndex\(\)/);
    expect(sidebar).toMatch(/private async workspaceFileIndex[\s\S]*?vscode\.workspace\.findFiles\("\*\*\/\*", FILE_INDEX_EXCLUDE, MAX_INDEXED_FILES\)/);
    // A failed listing must not raise the composer's error banner.
    expect(sidebar).toMatch(/private async workspaceFileIndex[\s\S]*?\} catch \{[\s\S]*?paths = \[\];/);
  });

  it("sends on Enter in chat modes and keeps Enter as a newline in Code mode", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    const submit = editor.slice(
      editor.indexOf("private submitKeymapExtension"),
      editor.indexOf("setSubmitOnEnter")
    );
    // Code mode is a real editor, so the compartment resolves to nothing there
    // and Mod-Enter stays the only way to run.
    expect(submit).toContain("if (this.languageEnabled || !this.submitOnEnter) return [];");
    expect(submit).toMatch(/key: "Enter"[\s\S]*?if \(acceptCompletion\(view\)\) return true;[\s\S]*?this\.options\.onRun\(\);/);
    expect(submit).toContain('{ key: "Shift-Enter", run: insertNewlineAndIndent }');
    expect(editor).toContain("this.submitKeymap.of(this.submitKeymapExtension())");
    // Switching modes is what flips the binding, so the compartment has to be
    // reconfigured alongside the language and wrapping ones.
    expect(editor).toMatch(/setLanguageEnabled\(enabled: boolean\)[\s\S]*?this\.submitKeymap\.reconfigure\(this\.submitKeymapExtension\(\)\)/);
    expect(editor).toContain('{ key: "Mod-Enter", run: () => { this.options.onRun(); return true; } }');
    // The compartment has to outrank the default Enter binding below it.
    expect(editor.indexOf("this.submitKeymap.of(")).toBeLessThan(editor.indexOf("...defaultKeymap"));
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

  it("offers edit-and-resend and retry on every output turn", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    const css = await source("media/styles.css");
    const history = await source("src/historyRender.ts");
    // The summary is its own click target, so an action click must not fold the
    // turn it belongs to.
    expect(main).toMatch(/function turnActionButton[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
    expect(main).toMatch(/turnActionButton\("edit", "Edit and resend", \(\) => \{[\s\S]*?editor\.setValue\(source\)/);
    expect(main).toMatch(/turnActionButton\("debug-restart", "Retry this turn", \(\) => \{[\s\S]*?type: "retryTurn", turnId/);
    expect(main).toContain("summary.append(chevron, time, title, actions);");
    // Actions have to go dead while a turn is running, including turns created
    // after the run started.
    expect(main).toContain("button.disabled = executing;");
    expect(main).toMatch(/function updateRunState[\s\S]*?syncTurnActions\(\);/);
    expect(sidebar).toMatch(/case "retryTurn":[\s\S]*?this\.activeSession\.turns\.find\(\(item\) => item\.id === request\.turnId\)/);
    // Retry reproduces the recorded mode rather than whatever is selected now.
    expect(sidebar).toContain("await this.run(turn.mode ?? this.application.state().agentSelection.mode ?? \"agent\", turn.input);");
    expect(sidebar).toContain("await this.history.addSuccess(source, events, response, sessionId, mode);");
    expect(css).toMatch(/\.output-turn > summary:hover \.output-turn-actions,[\s\S]*?opacity: 1;/);
    // History's actions are a context menu with no affordance, so the row says so.
    expect(history).toContain('const TURN_ACTION_HINT = "Right-click for turn and conversation actions";');
    expect(history).toContain('<summary title="${SESSION_ACTION_HINT}">');
  });

  it("clears submitted text and its attachment chips without deleting the files", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/sidebarProvider.ts");
    expect(main).toMatch(/vscode\.postMessage\(\{ type: "executeInput", mode: inputMode, source \}\);[\s\S]*?clearSubmittedInput\(\);/);
    const clear = main.slice(
      main.indexOf("function clearSubmittedInput"),
      main.indexOf("elements.run.addEventListener")
    );
    expect(clear).toContain('editor.setValue("");');
    // The chips stood for references that left with the turn, so they go too.
    expect(clear).toContain("imageAttachments.clear();");
    expect(clear).toContain('elements.attachmentBar.classList.add("hidden");');
    // The recorded turn still points at those files, so submitting must not
    // ask the host to delete them.
    expect(clear).not.toContain("deleteImageAttachment");
    expect(main).not.toContain("function clearImageAttachments");
    expect(main).toMatch(/image-attachment-remove[\s\S]*?type: "deleteImageAttachment"/);
    expect(sidebar).toMatch(/private setRunning\(running: boolean\): void \{[\s\S]*?"setContext", "dext\.running", running/);
    expect(sidebar).toMatch(/stopExecution\(\): void \{[\s\S]*?this\.activeExecution\.controller\.abort\(\);/);
  });

  it("defers temporary image deletion until the running turn has consumed its input", async () => {
    const sidebar = await source("src/sidebarProvider.ts");
    expect(sidebar).toContain("private readonly pendingAttachmentDeletes = new Set<string>();");
    expect(sidebar).toMatch(/case "deleteImageAttachment":[\s\S]*?if \(this\.running\) this\.pendingAttachmentDeletes\.add\(request\.relativePath\);/);
    expect(sidebar).toMatch(/this\.setRunning\(false\);[\s\S]*?await this\.flushAttachmentDeletes\(\);/);
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
