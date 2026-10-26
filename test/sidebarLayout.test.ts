import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionMetadata, InputExecutionResponse, PatchChange } from "../src/shared/contracts/types.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";

vi.mock("vscode", () => ({}));

import { conversation, createConversationHarness } from "./conversationHarness.js";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

function turn(id: string): DextHistoryRecord {
  return { id, createdAt: 1, input: "hello", process: [], output: "ok" };
}

function emptyResponse(): InputExecutionResponse {
  return { kind: "workflow", executions: [] };
}

function gatedExecution(): {
  executeConversation: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>;
  release: () => void;
  started: () => boolean;
  metadata: Readonly<ExecutionMetadata>[];
} {
  const gates: Array<() => void> = [];
  const metadata: Readonly<ExecutionMetadata>[] = [];
  return {
    executeConversation: async (_mode, _source, meta) => {
      metadata.push(meta);
      await new Promise<void>((resolve) => gates.push(resolve));
      return emptyResponse();
    },
    release: () => gates.shift()?.(),
    started: () => gates.length > 0,
    metadata
  };
}

function patchResponse(apply: boolean, changes: PatchChange[] = [{ uri: "file:///x", before: "before", after: "after" }]): InputExecutionResponse {
  return {
    kind: "workflow",
    executions: [{
      invocation: { kind: "invocation", method: "agent", arguments: [{ name: "apply", value: apply }], source: "chat" },
      method: { id: "agent", title: "Agent", kind: "command", source: "builtin" },
      durationMs: 1,
      result: { kind: "agent", text: "", patch: { kind: "patch", title: "Proposal", changes } }
    }]
  };
}

describe("sidebar panel layout", () => {
  it("advertises Pi permission limitations without upgrading the stored selection", async () => {
    const main = await source("src/webview/main.ts");
    expect(main).toContain("writablePermissions");
    expect(main).toContain("button.disabled = true");
    expect(main.includes("Pi does not support Workspace write.")).toBe(true);
    expect(main.includes('button.dataset.permissionDisabled === "true"')).toBe(true);
    const extension = await source("src/extension.ts");
    expect(extension).toContain('vscode.Uri.joinPath(context.extensionUri, "media", "pi-extension.mjs")');
  });
  it("uses prose typography and compact refs for sent Input without changing composer chips", async () => {
    const css = await source("media/styles.css");
    expect(css).not.toContain("--dext-input-line-height");
    expect(await source('src/webview/codeEditor.ts')).toContain('lineHeight: 24');
    expect(css).toMatch(/\.attachment-chip \{[^}]*height: 24px;/);
    expect(css).toMatch(/\.output-turn-input > pre\.dext-source,\s*\.markdown-body \{\s*font: var\(--vscode-font-size, 13px\)\/1.5 var\(--vscode-font-family\);/);
    expect(css).toMatch(/\.output-turn-input \.attachment-chip \{\s*height: 20px;\s*margin-block: 2px;/);
    expect(css).toMatch(/\.output-turn-input \.attachment-open \{\s*height: 18px;\s*font: inherit;/);
  });

  it("shares title-to-body spacing across Input, Process, and Output without stacking first-item gaps", async () => {
    const css = await source("media/styles.css");
    expect(css).toMatch(/\.turn-section > \.turn-section-body \{\s*padding: 8px 4px 8px 18px;/);
    expect(css).toMatch(/\.turn-section-body > :first-child,\s*\.turn-section-body > \.execution-result:first-child > :first-child,\s*\.turn-section-body > \.agent-stream-panel > :first-child \{\s*margin-top: 0;/);
    expect(css).toMatch(/\.turn-section-body > \.agent-stream-panel \{\s*padding-top: 0;/);
  });

  it("starts background Harness model discovery when the sidebar opens or Harness is selected", async () => {
    const sidebar = await source("src/app/sidebarProvider.ts");
    expect(sidebar).toContain("private harnessModelsDiscovered = false;");
    expect(sidebar).toMatch(/resolveWebviewView[\s\S]*?discoverHarnessModelsOnce\(\)\.then/);
    expect(sidebar).toMatch(/case "agentSelection":[\s\S]*?selection\.profileId === "deepseek-harness" && previousProfileId !== "deepseek-harness"[\s\S]*?void this\.discoverHarnessModelsOnce\(\)\s*\.then/);
    expect(sidebar).toMatch(/private discoverHarnessModelsOnce\(\): Promise<void>[\s\S]*?this\.harnessModelsDiscovered = true/);
  });

  it("renders Harness model-provider groups in the model choices", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(main).toContain("composer-model-group-heading");
    expect(main).toMatch(/for \(const \{ value, label, group \} of items\)[\s\S]*?heading\.textContent = group/);
    expect(css).toContain(".composer-model-group-heading {");
  });

  it("moves API and Global Resources out of the sidebar into editor tabs", async () => {
    const html = await source("src/app/sidebarProvider.ts");
    const manifest = await source("package.json");
    const extension = await source("src/extension.ts");
    expect(html).toContain('<section id="input-section" class="input-section">');
    expect(html).toContain('id="input-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true"');
    expect(html).not.toContain('id="view-methods"');
    expect(manifest).toContain('"command": "dext.viewApis"');
    // The directory dialogs are gone; the commands open editor tabs instead.
    expect(html).not.toContain('<dialog id="methods-dialog"');
    expect(html).not.toContain('<dialog id="mcp-dialog"');
    expect(html).not.toMatch(/viewApis\(\): void \{\r?\n[ ]{4}this\.postWhenReady\(\{ type: "openMethods" \}\);/);
    expect(extension).toContain('vscode.commands.registerCommand("dext.viewApis"');
    expect(extension).toContain("editors.api?.showList()");
    expect(extension).toContain("editors.globalResources?.showList()");
    expect(html).not.toContain('id="methods-section"');
    expect(html.indexOf('id="result-section"')).toBeLessThan(html.indexOf('id="input-section"'));
    expect(html).toMatch(/id="input-body" class="collapsible-body input-body"[\s\S]*id="input-shell"[\s\S]*id="attachment-bar"[\s\S]*class="action-row"/);
    expect(html.match(/class="icon-button panel-fullscreen"/g)).toBeNull();
  });

  it("creates resources in the shared conversation composer with resource controls", async () => {
    const html = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    expect(html).toContain('id="create-resource"');
    expect(html).not.toContain('id="resource-creator-dialog"');
    expect(html).toContain('id="resource-toolbar"');
    expect(html).toContain('id="resource-preview"');
    expect(html).toContain('id="resource-save"');
    expect(main).toContain('type: "openResourceCreator"');
    expect(main).toContain('renderResourceControls()');
    expect(main).not.toContain('resourceCreatorDialog');
  });

  it("uses the shared mouse and keyboard disclosure behavior", async () => {
    const main = await source("src/webview/main.ts");
    const transcript = await source("src/features/conversations/browser/transcriptView.ts");
    expect(main).toContain('inputHeading: element<HTMLElement>("input-heading")');
    expect(main).toContain('inputBody: element<HTMLElement>("input-body")');
    expect(transcript).toContain('const input = this.section(turnPresentation.input, true, this.host.copy(source));');
    expect(main).toMatch(/elements\.inputHeading\.addEventListener\("click",[\s\S]*toggleSection\(elements\.inputHeading, elements\.inputBody\)/);
    expect(main).toMatch(/elements\.inputHeading\.addEventListener\("keydown",[\s\S]*event\.key === "Enter" \|\| event\.key === " "[\s\S]*toggleSection\(elements\.inputHeading, elements\.inputBody\)/);
  });

  it("uses exactly Mode, Agent, and Model controls for the input footer", async () => {
    const html = await source("src/app/sidebarProvider.ts");
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
    expect(main).toContain('editor.setMode(inputMode === "code" ? "code" : "chat")');
    expect(main).toContain('elements.inputShell.classList.toggle("conversation-mode", !codeMode)');
    expect(main).toContain('elements.inputSection.dataset.mode = resource ? "resource" : inputMode');
    expect(main).toContain('elements.modeControlIcon.className = `codicon ${modeIcon[inputMode]}`');
    expect(editor).toContain('wordWrap: enabled ? "off" : "on"');
    expect(editor).toContain('lineNumbers: enabled ? "on" : "off"');
    expect(css).toContain('.monaco-editor .view-line .dext-ref-chip');
    expect(css).toContain('.input-section[data-mode="ask"] #mode-control');
    expect(css).toContain('.input-section[data-mode="plan"] #mode-control');
    expect(css).toContain('.input-section[data-mode="code"] #mode-control');
    expect(css).toMatch(/\.composer-control-label \{[\s\S]*?display: none;/);
    expect(css).toMatch(/#model-control \{[\s\S]*?background: transparent;/);
    expect(css).not.toContain('.input-section[data-mode="ask"] .composer-menu:has(#agent-control)');
    expect(css).not.toContain('.input-section[data-mode="code"] .composer-menu:has(#agent-control)');
  });

  it("keeps the composer usable when the Dext view is made very narrow", async () => {
    const css = await source("media/styles.css");
    // VS Code does not expose a minimum-width option for Webview Views, so the
    // webview supplies the minimum canvas and lets the host scroll it.
    expect(css).toMatch(/body \{[\s\S]*?min-width: 300px;/);
    // Extra controls collapse into a popover; Send stays on the same line.
    expect(css).toMatch(/\.action-row \{[\s\S]*?flex-wrap: nowrap;/);
    expect(css).toMatch(/\.composer-controls \{[\s\S]*?flex: 0 1 auto;[\s\S]*?flex-wrap: nowrap;/);
    expect(css).toMatch(/\.composer-menu \{[\s\S]*?min-width: 0;[\s\S]*?flex: 0 1 auto;/);
  });

  it("offers Plan beside Agent, Ask, and Code and lands its result as a document", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/app/sidebarProvider.ts");
    const application = await source("src/app/application.ts");
    const history = await source("src/features/conversations/presentation/historyRender.ts");
    const builtins = await source("src/features/workflow/domain/builtins.ts");
    const planControls = await source("src/features/conversations/browser/planControls.ts");
    expect(sidebar).toContain('<div class="plan-target-group">');
    expect(main).toMatch(/renderComposerMenu\(elements\.modeMenu, \[[\s\S]*?\["plan", "Plan", "codicon-checklist"\]/);
    expect(main).toContain('plan: "Plan"');
    // A plan turn ends in a file, so the result offers the file and the handoff.
    expect(main).toContain('plan: (planPath) => planActions(document, planPath');
    expect(planControls).toMatch(/export function planActions\([\s\S]*?open\(planPath\)/);
    expect(main).toMatch(/type: "buildPlan", planPath/);
    expect(builtins).toMatch(/id: "plan",\s*title: "Plan",/);
    expect(application).toMatch(/mode === "plan" && !metadata\.executePlan/);
    expect(application).toMatch(/private async savePlan[\s\S]*?splitPlanResponse\(result\.text\)/);
    expect(application).toMatch(/private async savePlan[\s\S]*?text: plan\.conversation, planPath/);
    expect(application).toMatch(/private async savePlan[\s\S]*?const workspaceStorage = this\.storage\.location\(\) === "workspace"/);
    expect(application).toMatch(/private async savePlan[\s\S]*?this\.storage\.directory\("plans"\)/);
    expect(application).toMatch(/private async savePlan[\s\S]*?planPath \}/);
    expect(application).toContain("globalDiagnostics: this.globalDiagnostics");
    expect(application).not.toContain('mcpDiagnostics: this.configDiagnostics.filter((item) => item.toLowerCase().includes("mcp"))');
    // Building re-reads the plan file through the host port, so the turn runs
    // on the current text in the editor rather than the text that created it.
    // The old sidebar also pre-checked application.planUri; PlanController.build
    // now delegates that existence check to its readPlan port (a missing plan
    // throws "no longer available"), so the observable contract is the read
    // text plus the plan path handed to the turn.
    type ExecuteConversation = (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>;
    const execute = vi.fn<ExecuteConversation>(async () => emptyResponse());
    const h = createConversationHarness({ planText: "Ship the plan exactly as edited.", executeConversation: execute });
    await h.controller.start();
    await h.plans.build("plans/ship.plan.md");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe("plan");
    expect(String(execute.mock.calls[0]?.[1])).toContain("Ship the plan exactly as edited.");
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ executePlan: true, planPath: "plans/ship.plan.md" });
    expect(h.controller.active().turns.at(-1)).toMatchObject({ executePlan: true, planPath: "plans/ship.plan.md" });
    h.dispose();
    // History replays the document link but not the handoff button.
    expect(history).toContain('plan: (path) => ({ html: planLink(path) })');
    expect(history).not.toContain('type: "buildPlan"');
  });

  it("hands the webview the settings it renders with instead of guessing", async () => {
    const main = await source("src/webview/main.ts");
    const patches = await source("src/features/conversations/browser/patchReviewView.ts");
    const application = await source("src/app/application.ts");
    const extension = await source("src/extension.ts");
    expect(application).toMatch(/private webviewSettings[\s\S]*?diffView: diffView === "split" \? "split" : "inline"/);
    expect(application).toMatch(/private webviewSettings[\s\S]*?submitOnEnter: configuration\.get<boolean>\("submitOnEnter", true\) !== false/);
    expect(main).toMatch(/if \(state\.settings\) \{[\s\S]*?patches\.diffMode = state\.settings\.diffView;[\s\S]*?editor\.setSubmitOnEnter\(state\.settings\.submitOnEnter\)/);
    // A new file change has to open in the configured layout, not always inline.
    expect(patches).toContain("view.dataset.diffView = this.diffMode;");
    expect(patches).toContain('button.className = `diff-mode-button${mode === this.diffMode ? " active" : ""}`');
    // Saving project paths changes the registered API set, so it needs a reload.
    expect(extension).toMatch(/onWorkspaceSettingsChanged: async \(?settings\)? => \{\s*application\.setProjectWorkspaceSettings\(settings\);\s*await application\.reload\(\)/);
    expect(extension).toMatch(/event\.affectsConfiguration\("dext\.diff\.defaultView"\)[\s\S]*?await sidebar\.refresh\(\)/);
    // Configured API directories are searched, but `.dext/api` comes first.
    expect(application).toMatch(/apiRoots\(\): string\[\] \{/);
    expect(application).toMatch(/add\(vscode\.Uri\.joinPath\(vscode\.Uri\.file\(this\.workspaceRoot\), "\.dext", "api"\)\.fsPath\)/);
  });

  it("lays concurrent comprehension branches out beside one another", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    const application = await source("src/app/application.ts");
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
    expect(application).toContain('this.dispatchConcurrency = positive("workflow.maxConcurrency", DEFAULT_DISPATCH_CONCURRENCY)');
  });

  it("offers sandbox-escaping presets in Agent and Plan and marks them Build-only in Plan", async () => {
    const main = await source("src/webview/main.ts");
    const planControls = await source("src/features/conversations/browser/planControls.ts");
    // Plan applies the preset when the plan builds, so it may choose one that needs
    // Full access; Ask stays read-only and Code carries its own per-call permission.
    expect(main).toContain('const writable = inputMode === "agent" || inputMode === "plan";');
    expect(main).toContain('const fullAccess = state.agentSelection.permission === "full-access" && writable;');
    expect(main).toContain('const buildOnly = !restriction && Boolean(preset.writableTurnsOnly) && writable && inputMode === "plan";');
    expect(main).toContain('" (Build only)"');
    // Sending an Agent or Code turn applies the preset as-is; Plan's Send and Ask
    // are read-only, and building a plan is the writable turn that must check it.
    expect(main).toContain("function fullAccessPresetRestriction(writableTurn: boolean)");
    expect(main).toContain('const presetRestriction = fullAccessPresetRestriction(inputMode === "agent" || codeMode);');
    expect(main).toContain("This preset requires Full access in Agent or Plan mode.");
    expect(main).toContain("buildRestriction: () => fullAccessPresetRestriction(true)");
    expect(planControls).toContain("elements.build.disabled = Boolean(buildRestriction)");
  });

  it("offers exactly the installed Harness preset catalog and defaults to its own default", async () => {
    const main = await source("src/webview/main.ts");
    const defaults = await source("src/features/agents/domain/harnessPresetDefault.ts");
    // Dext no longer invents an "ACP default" entry: the catalog is the only
    // source of preset choices, and an unset selection runs the Harness default.
    expect(main).not.toContain("ACP default");
    expect(main).toContain("const presets: readonly HarnessPresetOption[] = profile?.presets ?? [];");
    expect(main).toContain("const selectedPreset = harnessPresetOrDefault(current.agentPreset);");
    expect(main).toContain("No Harness presets found. Refresh presets or check the installed Harness.");
    expect(defaults).toContain('export const DEFAULT_HARNESS_PRESET = "standard";');
  });

  it("shows writable permission tiers for Agent and Plan modes", async () => {
    const html = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/app/sidebarProvider.ts");
    const manifest = await source("package.json");
    const css = await source("media/styles.css");
    expect(html).toContain('id="permission-control"');
    expect(html).toContain('id="permission-menu-shell"');
    // Ask is the dedicated read-only mode; Agent and Plan expose write scope.
    expect(main).toContain('elements.permissionMenuShell.hidden = inputMode !== "agent" && inputMode !== "plan"');
    expect(main).toMatch(/renderComposerMenu\(elements\.permissionMenu, \[[\s\S]*?"full-access"/);
    expect(main).toContain('elements.permissionControl.classList.toggle("is-full-access", agentPermission === "full-access")');
    expect(main).toContain('}, ["full-access"]);');
    expect(main).toContain('permission: change.permission ?? agentPermission');
    expect(manifest).toContain('"dext.agentPermission"');
    expect(manifest).toContain('"dext.agentCliArgs"');
    // The host holds the patch, so the buttons only appear when it says so.
    const patchView = await source("src/features/conversations/browser/patchReviewView.ts");
    expect(main).toMatch(/renderResult\(message\.response, message\.reviewPatch \? message\.turnId : undefined\)/);
    expect(patchView).toMatch(/actions\(turnId: string, uris: readonly string\[\], suffix = ""\): HTMLElement \{[\s\S]*?this\.host\.resolve\(turnId, \[\.\.\.uris\], accept\)/);
    expect(patchView).toMatch(/applyResolution\([\s\S]*?if \(status === "conflict"\)[\s\S]*?button\.disabled = false/);
    // Patch ownership moved to the review controller: it holds only proposals
    // whose Agent call did not write, and resolves them one entry at a time.
    expect(sidebar).toMatch(/case "resolvePatch":[\s\S]*?this\.conversation\.patches\.resolve\(/);
    const patches = await source("src/features/conversations/host/patchReviewController.ts");
    expect(patches).toMatch(/function unappliedPatch[\s\S]*?argument\.name === "apply" && argument\.value !== false/);
    // The VS Code write lives behind an injected handler, so the controller
    // itself stays free of the editor API.
    expect(patches).toMatch(/const result = await this\.options\.applyPatch\(\{/);
    const setup = await source("src/app/conversationSetup.ts");
    expect(setup).toMatch(/applyPatch: applyPatchHandler/);
    // A conflict leaves the entry pending so it can be reviewed again.
    expect(patches).toMatch(/if \(result\.status === "applied" \|\| result\.status === "unchanged"\) \{\s*this\.forgetResolvedChanges/);

    const h = createConversationHarness();
    expect(h.patches.hold("review", patchResponse(false))).toBe(true);
    expect(h.patches.has("review")).toBe(true);
    await h.patches.resolve("session", "review", ["file:///x"], false);
    expect(h.patches.has("review")).toBe(false);
    expect(h.messages.at(-1)).toMatchObject({ type: "patchResolved", status: "rejected", uris: ["file:///x"] });
    // Applied proposals and no-op patches are not offered for review.
    expect(h.patches.hold("written", patchResponse(true))).toBe(false);
    expect(h.patches.hold("no-op", patchResponse(false, [{ uri: "file:///x", before: "same", after: "same" }]))).toBe(false);
    await expect(h.patches.resolve("session", "review", [], false)).rejects.toThrow("no longer available");
    h.dispose();
    expect(css).toContain(".patch-review-action.accept");
    expect(css).toContain(".agent-file-change.patch-conflict");
    expect(css).toContain("#permission-control.is-full-access {");
    expect(css).toContain(".composer-menu-option.composer-menu-option-warning {");
  });

  it("colors Send with the accent of the mode it will run in", async () => {
    const css = await source("media/styles.css");
    // Agent is the plain default; the other modes retint the shared accent
    // properties, which both the mode control and Send read.
    expect(css).toMatch(/\.input-section \{[\s\S]*?--composer-accent: var\(--vscode-button-background\);[\s\S]*?--composer-accent-fill: var\(--composer-accent\);[\s\S]*?--composer-accent-foreground: var\(--vscode-button-foreground\);/);
    expect(css).toMatch(/\.input-section\[data-mode="ask"\] \{\r?\n {2}--composer-accent: var\(--vscode-terminal-ansiGreen/);
    expect(css).toMatch(/\.input-section\[data-mode="plan"\] \{[\s\S]*?--composer-accent: var\(--dext-plan-label\);[\s\S]*?--composer-accent-fill: var\(--dext-plan-fill\)/);
    expect(css).toMatch(/\.input-section\[data-mode="plan"\] \{[\s\S]*?--composer-accent-foreground: var\(--dext-plan-foreground\)/);
    expect(css).toMatch(/\.input-section\[data-mode="code"\] \{\r?\n {2}--composer-accent: var\(--vscode-terminal-ansiCyan/);
    expect(css).toMatch(/#run \{[\s\S]*?color: var\(--composer-accent-foreground, var\(--vscode-button-foreground\)\);[\s\S]*?background: var\(--composer-accent-fill, var\(--vscode-button-background\)\);/);
    expect(css).toMatch(/#run:hover:not\(:disabled\) \{[\s\S]*?color-mix\([\s\S]*?var\(--composer-accent-fill/);
    // The mode control reads the same accent rather than repeating the colors.
    expect(css).toMatch(/\.input-section\[data-mode="code"\] #mode-control,\s*\.input-section\[data-mode="resource"\] #mode-control \{[\s\S]*?border-color: color-mix\(in srgb, var\(--composer-accent\) 68%[\s\S]*?color: var\(--composer-accent\);[\s\S]*?background: color-mix\(in srgb, var\(--composer-accent\) 14%/);
    expect(css).toMatch(/\.input-section\[data-mode="code"\] #mode-control:focus-visible,\s*\.input-section\[data-mode="resource"\] #mode-control:focus-visible \{[\s\S]*?outline: 1px solid var\(--composer-accent\);/);
    expect(css).not.toMatch(/\.input-section\[data-mode="(?:ask|plan|code)"\] #mode-control \{[\s\S]*?border-color: color-mix\(in srgb, var\(--vscode-focusBorder\)/);
  });

  it("switches conversations through editor-style tabs and keeps input errors out of Output", async () => {
    const html = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const manifest = await source("package.json");
    const css = await source("media/styles.css");
    // The old two-row header is gone: the toolbar lives in VS Code's view
    // title bar and the only webview chrome left is the tab strip.
    expect(html).not.toContain('class="chat-header"');
    expect(css).not.toContain(".chat-header");
    expect(html).toContain('<nav id="conversation-tabs" class="conversation-tabs" role="tablist"');
    expect(css).toMatch(/^\.app-shell \{[\s\S]*?flex-direction: column;/m);
    expect(css).toMatch(/^main \{\r?\n {2}flex: 1 1 auto;/m);
    expect(css).toMatch(/\.conversation-tab \{[\s\S]*?max-width: 190px;[\s\S]*?\}/);
    const tabs = await source("src/features/conversations/browser/conversationTabs.ts");
    expect(main).toMatch(/function renderConversations[\s\S]*?renderConversationTabs\(\{/);
    expect(tabs).toMatch(/conversation-tab-label[\s\S]*?conversation-tab-close/);
    expect(main).toMatch(/function selectConversation[\s\S]*?type: "selectConversation"/);
    expect(main).toMatch(/conversationTabs\.addEventListener\("dblclick"[\s\S]*?type: "newConversation"/);
    expect(main).toMatch(/function closeConversation[\s\S]*?type: "closeConversation"/);
    expect(manifest).toContain('"command": "dext.newConversation"');
    // History opens an already-open conversation by activating that same
    // in-memory session (host initiated), never by creating a second tab.
    const h = createConversationHarness({ layout: { openConversationIds: ["one", "two"], activeConversationId: "one" } });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const existing = h.controller.session("two")!;
    const beforeOpen = h.messages.length;
    await h.controller.open({ ...existing, turns: [] });
    expect(h.controller.active()).toBe(existing);
    expect(h.controller.session("two")).toBe(existing);
    await vi.waitFor(() => expect(h.messages.slice(beforeOpen)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "activeConversation", activeId: "two", hostInitiated: true }),
      expect.objectContaining({ type: "outputSession", hostInitiated: true })
    ])));
    expect(h.controller.layout().openConversationIds.filter((id) => id === "two")).toHaveLength(1);
    h.dispose();
    expect(html).toContain('id="input-error" class="input-error"');
    expect(main).toMatch(/function renderInputError[\s\S]*elements\.inputError\.hidden = false/);
    expect(main).toMatch(/message\.type === "error"[\s\S]*renderInputError\(message\.message\)/);
    expect(main).not.toContain("Code mode only");
  });

  it("closes a conversation tab without dropping the conversation from history", async () => {
    const h = createConversationHarness({ layout: { openConversationIds: ["one", "two"], activeConversationId: "two" } });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const beforeClose = h.messages.length;
    await h.controller.close("two");
    // The session store backs history, so closing a tab must never delete it.
    expect(h.history.list(true).map((session) => session.id).sort()).toEqual(["one", "two"]);
    expect(h.controller.session("two")).toBeDefined();
    expect(h.controller.layout().openConversationIds).toEqual(["one"]);
    // The neighbour replaces the closed tab instead of leaving a blank view.
    expect(h.controller.active().id).toBe("one");
    const posted = h.messages.slice(beforeClose);
    expect(posted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "conversations",
        activeId: "one",
        sessions: [expect.objectContaining({ id: "one" })]
      }),
      expect.objectContaining({ type: "outputSession", hostInitiated: true })
    ]));
    expect(posted.some((message) => message.type === "conversations" && message.sessions.some((session) => session.id === "two"))).toBe(false);
    h.dispose();
  });

  it("pins a conversation tab to the front of the strip and back onto the next reload", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    // A pin restores a tab even when the saved layout predates open tabs.
    const h = createConversationHarness({ layout: { openConversationIds: ["a", "c"], activeConversationId: "c" } });
    await h.preferences.setPinned("b", true);
    h.seed([conversation("a", [turn("a1")]), conversation("b", [turn("b1")]), conversation("c", [turn("c1")])]);
    expect(h.controller.ordered()).toEqual(["b", "a", "c"]);
    expect(h.controller.layout().openConversationIds).toContain("b");
    await h.controller.pin("c", true);
    expect(h.controller.ordered()).toEqual(["c", "b", "a"]);
    expect(h.preferences.pinned()).toEqual(["b", "c"]);
    // Closing is an explicit dismissal, so it releases the pin as well.
    await h.controller.close("c");
    expect(h.preferences.isPinned("c")).toBe(false);
    expect(h.controller.layout().openConversationIds).not.toContain("c");
    expect(h.controller.ordered()).toEqual(["b", "a"]);
    h.dispose();
    const tabs = await source("src/features/conversations/browser/conversationTabs.ts");
    expect(tabs).toMatch(/tab\.dataset\.vscodeContext = JSON\.stringify\(\{[\s\S]*?webviewSection: "conversationTab"[\s\S]*?dextTabPinned: conversation\.pinned/);
    expect(tabs).toMatch(/conversation\.pinned \? "conversation-tab-pin" : "conversation-tab-close"/);
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

  it("shows provider token usage in Process only when the provider reports it", async () => {
    const main = await source("src/webview/main.ts");
    expect(main).toContain("let agentTokenUsage: AgentTokenUsage | undefined;");
    expect(main).toMatch(/function renderAgentEvent[\s\S]*?if \(event\.usage\) agentTokenUsage = updateTurnTokenUsage\(agentTokenUsage, event\.usage\);/);
    expect(main).toMatch(/function updateAgentProgress[\s\S]*?formatTurnTokenUsage\(agentTokenUsage\)/);
  });

  it("keeps Process as the only disclosure around the live agent timeline", async () => {
    const main = await source("src/webview/main.ts");
    const css = await source("media/styles.css");
    expect(main).toMatch(/function agentStreamPanel[\s\S]*?transcript\.active\?\.process[\s\S]*?transcript\.active\?\.processMeta/);
    expect(main).not.toContain('trace.className = "agent-run-disclosure"');
    expect(css).not.toContain(".agent-run-disclosure");
  });

  it("opens workspace Markdown links from output in the editor", async () => {
    const main = await source("src/webview/main.ts");
    const outputLinks = await source("src/features/workspace/browser/outputLink.ts");
    expect(main).toMatch(/function openOutputLink[\s\S]*?closest<HTMLAnchorElement>\("a\[href\]"\)[\s\S]*?type: "openFileReference"/);
    expect(main).toContain('elements.result.addEventListener("click", openOutputLink);');
    expect(main).toContain('type: "openExternalLink", url: externalUrl');
    expect(outputLinks).toContain('value.toLowerCase().startsWith("file:")');
    expect(outputLinks).toContain('export function outputExternalLink');
    expect(main).toContain("linkify: true");
  });

  it("offers the @ file picker in every mode and inserts the same chip as a drop", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    const sidebar = await source("src/app/sidebarProvider.ts");
    // Completion comes from Monaco's TypeScript worker plus the generated `dext`
    // declaration, so there is no hand-written provider left to point at.
    const typescript = await source("src/webview/monacoTypescript.ts");
    expect(typescript).toContain('addExtraLib');
    expect(typescript).toContain('dextTypes');
    expect(editor).toContain('installDextTypescript');
    expect(sidebar).toContain('await this.fileSearch.search(request)');
    const search = await source("src/features/workspace/host/fileSearchController.ts");
    expect(search).toMatch(/const paths = await this\.workspaceFileIndex\(\)[\s\S]*?rankFileMatches\(paths/);
    expect(search).toMatch(/private async workspaceFileIndex[\s\S]*?vscode\.workspace\.findFiles\("\*\*\/\*", FILE_INDEX_EXCLUDE, MAX_INDEXED_FILES\)/);
    // A failed listing must not raise the composer's error banner.
    expect(search).toMatch(/private async workspaceFileIndex[\s\S]*?\} catch \{[\s\S]*?paths = \[\];/);
  });

  it("sends on Enter in chat modes and keeps Enter as a newline in Code mode", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    expect(editor).toContain('dextChatEnter && !suggestWidgetVisible');
    expect(editor).toContain('this.chatEnter.set(!enabled && this.submitOnEnter)');
    expect(editor).toContain('monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter');
    expect(editor).toContain('monaco.KeyMod.Shift | monaco.KeyCode.Enter');

  });

  it("refreshes Send state when conversation text changes with language services disabled", async () => {
    const editor = await source("src/webview/codeEditor.ts");
    const main = await source("src/webview/main.ts");
    expect(editor).toContain("this.options.onSourceChanged?.();");
    expect(main).toMatch(/onSourceChanged\(\)\s*\{[\s\S]*?updateRunState\(\);/);
  });

  it("keeps the composer visible while allowing the history, editor, and attachments to shrink", async () => {
    const css = await source("media/styles.css");
    expect(css).toMatch(/\.input-section \{[\s\S]*?--input-editor-height: clamp\(112px, 24vh, 240px\);[\s\S]*?flex: 0 0 auto;[\s\S]*?max-height: calc\(100% - 44px\);[\s\S]*?overflow: hidden;[\s\S]*?\}/);
    expect(css).toMatch(/\.input-panel \{[\s\S]*?height: var\(--input-editor-height\);[\s\S]*?flex: 0 1 var\(--input-editor-height\);/);
    expect(css).toMatch(/\.code-editor \{[\s\S]*?height: 100%;[\s\S]*?min-height: 0;[\s\S]*?\}/);
    expect(css).toMatch(/\.attachment-bar \{[\s\S]*?max-height: 76px;[\s\S]*?overflow: auto;[\s\S]*?\}/);
    expect(css).toMatch(/\.input-section\.section-collapsed,[\s\S]*?\.result-section\.section-collapsed \{[\s\S]*?flex: 0 0 auto;/);
    expect(css).toMatch(/\.result-section \{[\s\S]*?flex: 1 1 0;/);
    expect(css).toMatch(/#result-body \{[\s\S]*?flex-basis: 0;[\s\S]*?min-height: 0;[\s\S]*?overflow: auto;/);
    expect(css).toMatch(/#result-body \{[\s\S]*?scrollbar-gutter: stable;/);
    expect(css).toMatch(/@media \(max-height: 480px\)[\s\S]*?\.input-section \{[\s\S]*?--input-editor-height: clamp\(56px, 20vh, 96px\);/);
  });

  it("keeps the jump-to-latest control clear of the host scrollbar", async () => {
    const css = await source("media/styles.css");
    const main = await source("src/webview/main.ts");
    // The host owns the webview scrollbar width (VS Code paints a 10px slider,
    // Chromium a wider one). A fixed offset can land the floating control on the
    // track, which hides the thumb exactly where the reader drags it to reach the
    // end of the output, so the control uses the gutter main.ts measures.
    expect(css).toMatch(/\.stream-jump-latest \{[\s\S]*?right: calc\(var\(--dext-result-scroll-gutter, \d+px\) \+ \d+px\);/);
    expect(css).not.toMatch(/\.stream-jump-latest \{[\s\S]*?right: 28px;/);
    const scrollSource = await source("src/features/conversations/browser/outputScrollController.ts");
    expect(scrollSource).toMatch(/syncGutter\(\): void \{[\s\S]*?body\.offsetWidth - body\.clientWidth/);
    expect(main).toMatch(/elements\.resultSection\.append\(jumpToLatest\);\s*syncResultScrollGutter\(\);/);
    expect(main).toMatch(/addEventListener\("resize", syncResultScrollGutter/);
  });

  it("offers edit-and-resend and retry on every output turn", async () => {
    const main = await source("src/webview/main.ts");
    const transcript = await source("src/features/conversations/browser/transcriptView.ts");
    const sidebar = await source("src/app/sidebarProvider.ts");
    const css = await source("media/styles.css");
    const history = await source("src/features/conversations/presentation/historyRender.ts");
    // The summary is its own click target, so an action click must not fold the
    // turn it belongs to.
    expect(transcript).toMatch(/private actionButton[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
    expect(main).toMatch(/edit: \(source\) => editor\.setValue\(source\)/);
    expect(transcript).toMatch(/this\.actionButton\(TURN_EDIT_ACTION\.icon, TURN_EDIT_ACTION\.label, \(\) => \{[\s\S]*?this\.host\.edit\(source\)/);
    expect(main).toMatch(/renameTurn: \(sessionId, turnId\) => vscode\.postMessage\(\{ type: "renameTurn", sessionId, turnId \}\)/);
    expect(sidebar).toMatch(/case "renameTurn":[\s\S]*?sessionId: request.sessionId/);
    expect(main).toMatch(/retryTurn: \(sessionId, turnId\) => vscode\.postMessage\(\{ type: "retryTurn", sessionId, turnId \}\)/);
    expect(main).toMatch(/forkFromTurn: \(sessionId, turnId\) => vscode\.postMessage\(\{ type: "forkFromTurn", sessionId, turnId \}\)/);
    expect(transcript).toContain("summary.append(chevron, title, planExecutionStatus, time, actions);");
    const actionOrder = [...transcript.matchAll(/this\.actionButton\((TURN_\w+_ACTION)\.icon/g)].map((match) => match[1]);
    expect(actionOrder).toEqual([
      "TURN_EDIT_ACTION", "TURN_RETRY_ACTION", "TURN_RENAME_ACTION", "TURN_FORK_ACTION", "TURN_COPY_ACTION", "TURN_DELETE_ACTION"
    ]);
    // Only destructive actions on the active turn go dead while a turn is
    // running; copying and editing older turns remains available.
    expect(main).toMatch(/function syncTurnActions[\s\S]*?data-disable-while-running[\s\S]*?button\.disabled = executing &&/);
    expect(main).toMatch(/function updateRunState[\s\S]*?syncTurnActions\(\);/);
    expect(sidebar).toMatch(/case "retryTurn":[\s\S]*?dext\.history\.retryTurn[\s\S]*?sessionId: request.sessionId \?\? this\.activeSession\.id/);
    expect(sidebar).toMatch(/case "forkFromTurn":[\s\S]*?dext\.history\.forkFromTurn[\s\S]*?sessionId: request.sessionId \?\? this\.activeSession\.id/);
    // Retry reproduces the recorded mode rather than whatever is selected now.
    expect(sidebar).toContain("await this.run(turn.mode ?? this.application.state().agentSelection.mode ?? \"agent\", turn.input);");
    // The coordinator persists the turn under the webview's live turn id and
    // the mode the retry ran in, so retry/delete still address the saved row.
    const execution = gatedExecution();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    await h.controller.start();
    const active = h.controller.active();
    const running = h.coordinator.execute(active, "plan", "retry me");
    await vi.waitFor(() => expect(h.coordinator.running(active.id)).toBe(true));
    await vi.waitFor(() => expect(execution.started()).toBe(true));
    const turnId = h.coordinator.turnOf(active.id)!;
    execution.release();
    await running;
    const stored = h.history.list(true).find((session) => session.id === active.id)!.turns.at(-1)!;
    expect(stored).toMatchObject({ id: turnId, mode: "plan", input: "retry me" });
    expect(active.turns.at(-1)?.id).toBe(turnId);
    h.dispose();
    expect(css).toMatch(/\.output-turn > summary:hover \.output-turn-actions,[\s\S]*?opacity: 1;/);
    expect(history).toContain('const TURN_ACTION_HINT = "Right-click for turn actions";');
    expect(css).toMatch(/\.history-record > summary:hover \.history-turn-actions,[\s\S]*?opacity: 1;/);
    expect(history).toContain('<summary title="${SESSION_ACTION_HINT}">');
  });

  it("clears submitted text and its attachment chips without deleting the files", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/app/sidebarProvider.ts");
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
    // `dext.running` and Stop are still the sidebar's context/commands, but the
    // live execution they describe now belongs to the coordinator.
    const execution = gatedExecution();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    await h.controller.start();
    const active = h.controller.active();
    const running = h.coordinator.execute(active, "agent", "work");
    await vi.waitFor(() => expect(h.coordinator.running(active.id)).toBe(true));
    await vi.waitFor(() => expect(execution.started()).toBe(true));
    expect(h.coordinator.abort(active.id)).toBe(true);
    expect(execution.metadata[0]?.signal?.aborted).toBe(true);
    execution.release();
    await running;
    expect(h.coordinator.running(active.id)).toBe(false);
    expect(h.history.list(true).find((session) => session.id === active.id)!.turns.at(-1)?.error).toContain("stopped by user");
    expect(sidebar).toMatch(/private updateRunningContext\(\): void \{[\s\S]*?"dext\.running",[\s\S]*?this\.running\(this\.activeSession\.id\)/);
    expect(sidebar).toMatch(/stopExecution\(\): void \{[\s\S]*?this\.conversation\.coordinator\.abort\(this\.activeSession\.id\)/);
    h.dispose();
  });

  it("defers temporary image deletion until the running turn has consumed its input", async () => {
    const sidebar = await source("src/app/sidebarProvider.ts");
    expect(sidebar).toContain("private readonly pendingAttachmentDeletes = new Set<string>();");
    expect(sidebar).toMatch(/case "deleteImageAttachment":[\s\S]*?if \(this\.conversation\.coordinator\.anyRunning\(\)\) this\.pendingAttachmentDeletes\.add\(request\.relativePath\);/);
    // Deferred deletes are flushed when the coordinator reports that no
    // conversation is running any more.
    const setup = await source("src/app/conversationSetup.ts");
    expect(setup).toContain("onIdle: dependencies.flushAttachmentDeletes");

    const execution = gatedExecution();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    await h.controller.start();
    const running = h.coordinator.execute(h.controller.active(), "agent", "work");
    await vi.waitFor(() => expect(h.coordinator.anyRunning()).toBe(true));
    await vi.waitFor(() => expect(execution.started()).toBe(true));
    execution.release();
    await running;
    expect(h.coordinator.anyRunning()).toBe(false);
    h.dispose();
  });

  it("keeps live trace entries in event arrival order and folds consecutive commands together", async () => {
    const main = await source("src/webview/main.ts");
    const trace = await source("src/features/conversations/browser/agentTraceView.ts");
    const css = await source("media/styles.css");
    expect(trace).toContain("private eventItems = new Map<string, HTMLElement>();");
    expect(trace).toContain("private group: AgentToolGroup | undefined;");
    expect(trace).toMatch(/renderEvent\(event: AgentStreamEvent\): void \{[\s\S]*?if \(event\.phase === "tool"\)[\s\S]*?this\.createToolCommand\(event, group\?\.body \?\? panel, group\)/);
    expect(trace).toMatch(/renderEvent\(event: AgentStreamEvent\): void \{[\s\S]*?this\.group = undefined;[\s\S]*?panel\.append\(item\);/);
    expect(trace).toMatch(/private updateGroupLabel[\s\S]*?Ran \$\{count\} command/);
    expect(trace).toMatch(/private createToolCommand[\s\S]*?document\.createElement\("details"\)/);
    expect(trace).toMatch(/renderEvent\(event: AgentStreamEvent\): void \{[\s\S]*?this\.host\.terminal\(raw\)/);
    expect(trace).toMatch(/private renderMessageItem[\s\S]*?body\.replaceChildren\(\.\.\.renderTurnMessage/);
    expect(css).toMatch(/\.terminal-output \{[\s\S]*?max-height: 360px;[\s\S]*?overflow: auto;[\s\S]*?white-space: pre-wrap;/);
    // Process has one whole-timeline copy control in its title bar; individual
    // messages and commands no longer add their own floating copies.
    expect(trace).not.toContain("this.host.copy");
    expect(css).not.toContain(".agent-trace-command-content > .output-copy");
    expect(css).not.toContain(".agent-stream-item > .output-copy");
    expect(css).not.toContain(".agent-stream-item > .copy-button");
    expect(trace).not.toContain("const order = { reasoning: 0, work: 1, files: 2, tool: 3 }");
    expect(main).not.toContain("const order = { reasoning: 0, work: 1, files: 2, tool: 3 }");
  });

  it("reproduces the grouping an agent reports and falls back to adjacency otherwise", async () => {
    const trace = await source("src/features/conversations/browser/agentTraceView.ts");
    expect(trace).toContain("private toolGroups = new Map<string, AgentToolGroup>();");
    // A named group is reused wherever it already sits, so a later step of the
    // same group is never split off into a new one.
    expect(trace).toMatch(/if \(event\.groupId\) \{[\s\S]*?this\.toolGroups\.get\(event\.groupId\)[\s\S]*?this\.toolGroups\.set\(event\.groupId, group\);/);
    expect(trace).toMatch(/if \(event\.solo\) \{\s*this\.group = undefined;\s*return undefined;/);
    expect(trace).toMatch(/const trailingGroup = \(group: AgentToolGroup \| undefined\): AgentToolGroup \| undefined =>[\s\S]*?group\.disclosure === panel\.lastElementChild \? group : undefined;/);
    expect(trace).toMatch(/const group = trailingGroup\(this\.group\) \?\? this\.createToolGroup\(parent\);/);
    expect(trace).toMatch(/private updateGroupLabel[\s\S]*?if \(group\.labelText\)/);
    // Replacing an earlier message must not split the run of commands below it.
    expect(trace).toMatch(/if \(!item\) \{\s*\/\/[\s\S]*?this\.group = undefined;/);
    expect(trace).not.toMatch(/this\.group = undefined;\s*const panel = this\.host\.panel\(\);/);
    expect(trace).toMatch(/reset\(\): void \{[\s\S]*?this\.toolGroups\.clear\(\);/);
  });

  it("renders trace prose in the UI font and command output as a code panel", async () => {
    const css = await source("media/styles.css");
    const trace = await source("src/features/conversations/browser/agentTraceView.ts");
    expect(css).toMatch(/\.agent-trace-message > \.agent-stream-text \{[\s\S]*?font-family: var\(--vscode-font-family\);[\s\S]*?white-space: normal;/);
    expect(css).toMatch(/\.agent-trace-command-body \{[\s\S]*?border: 1px solid var\(--vscode-widget-border\);/);
    expect(trace).toContain('body.className = "terminal-output agent-trace-command-body";');
    expect(trace).toMatch(/summary\.append\(this\.toolGlyph\(event\.toolKind\), summaryLabel, chevron\)/);
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
    // Keep checking the actual clipping ancestors, not any later occurrence
    // of overflow: visible elsewhere in the stylesheet.
    const overflowRule = css.match(/([^{}]*\.input-section:has\(\.composer-popover:not\(\[hidden\]\)\)[^{}]*)\{([^{}]*)\}/);
    expect(overflowRule?.[1]).toContain('.input-section:has(.composer-popover:not([hidden])) .input-body');
    expect(overflowRule?.[1]).toContain('.input-section:has(.composer-popover:not([hidden])) .input-panel');
    expect(overflowRule?.[1]).toContain('.input-section:has(.show-extra) .input-body');
    expect(overflowRule?.[2]).toContain('overflow: visible;');
  });

  it("does not reopen Output after a user folds it during result updates", async () => {
    const main = await source("src/webview/main.ts");
    const trace = await source("src/features/conversations/browser/agentTraceView.ts");
    const renderResult = main.slice(main.indexOf("function renderResult"), main.indexOf("function renderError"));
    const renderError = main.slice(main.indexOf("function renderError"), main.indexOf("function agentStreamPanel"));
    const renderAgentEvent = main.slice(main.indexOf("function renderAgentEvent"), main.indexOf("function resetAgentTrace"));
    expect(renderResult).not.toContain("setSectionOpen(elements.resultHeading, elements.resultBody, true)");
    expect(renderError).not.toContain("setSectionOpen(elements.resultHeading, elements.resultBody, true)");
    expect(renderAgentEvent).not.toContain("setSectionOpen(elements.resultHeading, elements.resultBody, true)");
    expect(trace).not.toContain("setSectionOpen");
  });

  it("keeps live Process output visible without disrupting manual scrolling", async () => {
    const main = await source("src/webview/main.ts");
    const scrollSource = await source("src/features/conversations/browser/outputScrollController.ts");
    // Following the stream is reader intent, not a per-batch measurement. A
    // batch taller than the tolerance used to make every later batch measure
    // "not at the end" and stop following for the rest of the turn.
    expect(scrollSource).toMatch(/private followingEnd = true;/);
    expect(scrollSource).toMatch(/isNearBottom\(\): boolean \{[\s\S]*?scrollHeight - scrollTop - clientHeight <= RESULT_END_TOLERANCE/);
    expect(scrollSource).toMatch(/snapToBottom\(\): void \{[\s\S]*?body\.scrollHeight - body\.clientHeight/);
    expect(scrollSource).toMatch(/pin\(\): void \{[\s\S]*?requestFrame[\s\S]*?snapToBottom\(\)/);
    expect(main).toMatch(/message\.type === "agentEvent" && message\.sessionId === browser\.activeId[\s\S]*?renderAgentEvent\(message\.event\);[\s\S]*?pinResultToBottom\(\);/);
    // A scroll the app did not start - a clamp after a disclosure shrank, a
    // scroll-anchored adjustment, or the correction's own scrollTop write -
    // must not cancel the pin that keeps the newest output in view.
    const scrollListener = main.slice(
      main.indexOf('elements.resultBody.addEventListener("scroll"'),
      main.indexOf('elements.resultBody.addEventListener("pointerdown"')
    );
    expect(scrollListener).toContain("scroll.onScroll()");
    expect(scrollListener).not.toContain("cancelScheduled");
    expect(main).toMatch(/const endResultScrollGesture[\s\S]*?scroll\.endPointerGesture\(event\)/);
    expect(main).toMatch(/addEventListener\("pointerup", endResultScrollGesture/);
    expect((await source("media/styles.css"))).toMatch(/#result-body \{[\s\S]*?overflow-anchor: none;/);
  });

  it("supports stop execution interactions", async () => {
    const main = await source("src/webview/main.ts");
    const sidebar = await source("src/app/sidebarProvider.ts");
    expect(main).not.toContain('type PanelName = "input" | "result"');
    expect(main).not.toContain('elements.main.classList.add("workspace-fullscreen")');
    expect(main).not.toMatch(/toggleFullscreen\(/);
    expect(main).not.toContain('onHeightChanged(height)');
    expect(main).toContain('vscode.postMessage({ type: "stopExecution", turnId: activeTurnId })');
    expect(sidebar).toMatch(/case "stopExecution":[\s\S]*?this\.conversation\.coordinator\.abortTurn\(request\.turnId\)/);

    // Active executions live in the coordinator, and Stop matches one turn id
    // so another conversation's turn keeps running.
    const execution = gatedExecution();
    const h = createConversationHarness({
      layout: { openConversationIds: ["one", "two"], activeConversationId: "one" },
      executeConversation: execution.executeConversation
    });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const first = h.coordinator.execute(h.controller.session("one")!, "agent", "first");
    const second = h.coordinator.execute(h.controller.session("two")!, "agent", "second");
    await vi.waitFor(() => {
      expect(h.coordinator.running("one")).toBe(true);
      expect(h.coordinator.running("two")).toBe(true);
      expect(execution.metadata).toHaveLength(2);
    });
    const firstTurn = h.coordinator.turnOf("one")!;
    expect(h.coordinator.active("one")?.turnId).toBe(firstTurn);
    h.coordinator.abortTurn(firstTurn);
    expect(execution.metadata[0]?.signal?.aborted).toBe(true);
    expect(execution.metadata[1]?.signal?.aborted).toBe(false);
    execution.release();
    execution.release();
    await Promise.all([first, second]);
    expect(h.history.list(true).find((session) => session.id === "one")!.turns.at(-1)?.error).toContain("stopped by user");
    expect(h.history.list(true).find((session) => session.id === "two")!.turns.at(-1)?.error).toBeUndefined();
    h.dispose();
  });

  it("keeps agent turns running independently across conversation tabs", async () => {
    const sidebar = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const protocol = await source("src/features/conversations/contracts/protocol.ts");
    const css = await source("media/styles.css");
    expect(sidebar).not.toContain("Wait for the current Dext turn to finish before starting another conversation.");
    // One execution per conversation: both tabs can run at once, each keeps
    // its own buffered events, and only the visible tab receives live batches.
    const metadataBySource = new Map<string, Readonly<ExecutionMetadata>>();
    const gates = new Map<string, () => void>();
    const h = createConversationHarness({
      layout: { openConversationIds: ["one", "two"], activeConversationId: "one" },
      executeConversation: async (_mode, source, metadata) => {
        metadataBySource.set(source, metadata);
        await new Promise<void>((resolve) => gates.set(source, resolve));
        return emptyResponse();
      }
    });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const first = h.coordinator.execute(h.controller.session("one")!, "agent", "first");
    const second = h.coordinator.execute(h.controller.session("two")!, "agent", "second");
    await vi.waitFor(() => {
      expect(h.coordinator.running("one")).toBe(true);
      expect(h.coordinator.running("two")).toBe(true);
      expect(metadataBySource.size).toBe(2);
    });
    const firstTurn = h.coordinator.turnOf("one")!;
    const secondTurn = h.coordinator.turnOf("two")!;
    metadataBySource.get("first")!.onAgentEvent?.({ phase: "message", text: "one-event" });
    metadataBySource.get("second")!.onAgentEvent?.({ phase: "message", text: "two-event" });
    expect(h.coordinator.active("one")?.events).toHaveLength(1);
    expect(h.coordinator.active("two")?.events).toHaveLength(1);
    gates.get("first")!();
    gates.get("second")!();
    await Promise.all([first, second]);
    expect(h.messages.some((message) => message.type === "agentEvent" && message.sessionId === "one")).toBe(true);
    expect(h.messages.some((message) => message.type === "agentEvent" && message.sessionId === "two")).toBe(false);
    expect(h.history.list(true).find((session) => session.id === "one")!.turns.at(-1)).toMatchObject({ id: firstTurn, mode: "agent" });
    expect(h.history.list(true).find((session) => session.id === "two")!.turns.at(-1)).toMatchObject({ id: secondTurn, mode: "agent" });
    h.dispose();
    expect(protocol).toContain('running: boolean;');
    expect(protocol).toContain('{ type: "agentEvent"; sessionId: string; event: AgentStreamEvent }');
    expect(main).toContain("const runningConversationIds = new Set<string>();");
    expect(main).toMatch(/function selectConversation[\s\S]*?sessionId === browser\.activeId/);
    expect(main).toMatch(/const activeChanged = browser\.setActiveId\(activeId\);[\s\S]*?activeChanged \|\| !runningConversationIds\.has\(activeId\)/);
    expect(main).toMatch(/message\.type === "agentEvent" && message\.sessionId === browser\.activeId/);
    expect(main).toMatch(/const existingTurn = transcript\.get\(message\.turnId\)/);
    // Codicons declares `.codicon[class*='codicon-'] { display: inline-block }`.
    // The idle rule must outrank even a later Monaco codicon rule.
    expect(css).toMatch(/\.conversation-tab \.conversation-tab-activity\.codicon \{[\s\S]*?display: none/);
    expect(css).toMatch(/\.conversation-tab\.running \.conversation-tab-activity[\s\S]*?display: inline-block/);
  });

  it("clears stale conversation output before a tab switch waits on IPC", async () => {
    const main = await source("src/webview/main.ts");
    const tabs = await source("src/features/conversations/browser/conversationTabs.ts");
    expect(main).toMatch(/function clearVisibleConversation[\s\S]*?cacheRenderedConversation\(\);[\s\S]*?elements\.result\.replaceChildren\(\);[\s\S]*?browser\.clearRendered\(\)/);
    expect(main).toMatch(/function selectConversation[\s\S]*?browser\.beginSelection\(sessionId\);[\s\S]*?clearVisibleConversation\(\);[\s\S]*?type: "selectConversation", sessionId, switchId/);
    expect(tabs).toMatch(/label\.addEventListener\("pointerdown",[\s\S]*?actions\.select\(conversation\.id\)/);
    expect(main).toMatch(/message\.type === "outputSession"[\s\S]*?message\.session\.id !== browser\.activeId/);
  });

  it("pins a restored running conversation to the latest replayed event", async () => {
    const main = await source("src/webview/main.ts");
    const scrollSource = await source("src/features/conversations/browser/outputScrollController.ts");
    expect(scrollSource).toMatch(/private forceInitialScroll = false;/);
    expect(main).toMatch(/message\.switchId !== undefined[\s\S]*?scroll\.forceInitialBottom\(\)[\s\S]*?scrollResultToBottom\(\)/);
    expect(main).toMatch(/if \(scroll\.consumeForcedInitialScroll\(\)\)[\s\S]*?scrollResultToBottom\(\)/);
  });

  it("preserves the original start time when restoring a running conversation", async () => {
    const sidebar = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    // The coordinator snapshots startedAt when the turn begins. Switching tabs
    // and restoring the live row reads that snapshot instead of restarting it.
    const execution = gatedExecution();
    const h = createConversationHarness({
      layout: { openConversationIds: ["one", "two"], activeConversationId: "one" },
      executeConversation: execution.executeConversation
    });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const one = h.controller.session("one")!;
    const two = h.controller.session("two")!;
    const running = h.coordinator.execute(one, "agent", "work");
    await vi.waitFor(() => expect(h.coordinator.running("one")).toBe(true));
    await vi.waitFor(() => expect(execution.started()).toBe(true));
    const active = h.coordinator.active("one")!;
    const startedAt = active.startedAt;
    const turnId = active.turnId;
    expect(startedAt).toBeGreaterThan(0);
    h.controller.activate(two);
    h.controller.activate(one);
    expect(h.coordinator.active("one")?.startedAt).toBe(startedAt);
    expect(h.coordinator.turnOf("one")).toBe(turnId);
    const setup = await source("src/app/conversationSetup.ts");
    expect(setup).toMatch(/type: "executing",[\s\S]*?turnId: snapshot\.turnId,[\s\S]*?startedAt: snapshot\.startedAt/);
    expect(sidebar).toMatch(/turnId: execution\.turnId,[\s\S]*?startedAt: execution\.startedAt/);
    execution.release();
    await running;
    expect(main).toMatch(/function startAgentProgress\(startedAt = Date\.now\(\)\)/);
    expect(main).toMatch(/startAgentProgress\(message\.startedAt\)/);
    h.dispose();
  });

  it("accepts host-initiated conversation switches without weakening local stale-response guards", async () => {
    const sidebar = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    expect(sidebar).toMatch(/async openConversation\(session: DextHistorySession\): Promise<void> \{\s*await this\.conversation\.controller\.open\(session\);/);
    // History, new conversations and closing a tab are host-initiated: their
    // payloads carry hostInitiated so the Webview accepts an active-id change
    // it did not request, while ordinary stale responses keep their guards.
    const h = createConversationHarness({ layout: { openConversationIds: ["one", "two"], activeConversationId: "two" } });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const beforeOpen = h.messages.length;
    await h.controller.open(h.controller.session("one")!);
    await vi.waitFor(() => expect(h.messages.slice(beforeOpen)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "activeConversation", activeId: "one", hostInitiated: true }),
      expect.objectContaining({ type: "outputSession", hostInitiated: true })
    ])));
    const beforeStart = h.messages.length;
    await h.controller.start();
    const startedId = h.controller.active().id;
    expect(h.messages.slice(beforeStart)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "conversations", activeId: startedId, hostInitiated: true })
    ]));
    const beforeClose = h.messages.length;
    await h.controller.close(startedId);
    await vi.waitFor(() => expect(h.messages.slice(beforeClose)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "outputSession", session: expect.objectContaining({ id: "two" }), hostInitiated: true })
    ])));
    h.dispose();
    expect(main).toMatch(/!message\.hostInitiated && browser\.activeId && message\.session\.id !== browser\.activeId/);
    expect(main).toMatch(/!message\.hostInitiated && message\.switchId === undefined && browser\.activeId && message\.activeId !== browser\.activeId/);
    expect(main).toMatch(/if \(browser\.activeId !== message\.activeId\) \{[\s\S]*?activeExecutionSessionId = undefined;[\s\S]*?clearVisibleConversation\(\);/);
  });

  it("snapshots replay events before awaiting the executing message", async () => {
    const sidebar = await source("src/app/sidebarProvider.ts");
    expect(sidebar).toMatch(/const replayEvents = \[\.\.\.execution\.events\];[\s\S]*?await this\.post\(\{[\s\S]*?type: "executing"[\s\S]*?\}\);[\s\S]*?events: replayEvents/);
  });

  it("restores a running conversation without relying on an evictable DOM cache", async () => {
    const main = await source("src/webview/main.ts");
    // A running conversation must be restored as a full output session even if
    // its signature was posted before: a cached-DOM ref can be evicted while
    // the live row is replayed and leave the view stuck loading.
    const execution = gatedExecution();
    const h = createConversationHarness({
      layout: { openConversationIds: ["one", "two"], activeConversationId: "one" },
      executeConversation: execution.executeConversation
    });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const one = h.controller.session("one")!;
    const two = h.controller.session("two")!;
    const running = h.coordinator.execute(one, "agent", "work");
    await vi.waitFor(() => expect(h.coordinator.running("one")).toBe(true));
    await vi.waitFor(() => expect(execution.started()).toBe(true));
    h.controller.markOutputPosted(one);
    let beforeSwitch = h.messages.length;
    h.controller.activate(two);
    h.controller.activate(one);
    await vi.waitFor(() => expect(h.messages.slice(beforeSwitch).some((message) => message.type === "outputSession" && message.session.id === "one")).toBe(true));
    expect(h.messages.slice(beforeSwitch).some((message) => message.type === "outputSessionRef")).toBe(false);

    execution.release();
    await running;
    // Once the turn is not live, the same cached signature may take the ref path.
    h.controller.markOutputPosted(one);
    beforeSwitch = h.messages.length;
    h.controller.activate(two);
    h.controller.activate(one);
    await vi.waitFor(() => expect(h.messages.slice(beforeSwitch).some((message) => message.type === "outputSessionRef" && message.sessionId === "one")).toBe(true));
    h.dispose();
    expect(main).toMatch(/const liveTurn = executing && activeExecutionSessionId === session\.id && transcript\.active && activeTurnId[\s\S]*?elements\.result\.append\(liveTurn\.disclosure\);[\s\S]*?transcript\.active = liveTurn/);
    expect(main).toMatch(/elements\.resultBody\.dataset\.loading !== "true"/);
  });

  it("copies turns through the host without changing the active stream", async () => {
    const transcript = await source("src/features/conversations/browser/transcriptView.ts");
    expect(transcript).toMatch(/this\.actionButton\(TURN_COPY_ACTION\.icon, TURN_COPY_ACTION\.label, \(\) => \{\s*if \(sessionId\) this\.host\.copyTurn\(sessionId, turnId\);\s*\}, true\)/);
  });

  it("explains an empty Harness model picker instead of showing a blank menu", async () => {
    const main = await source("src/webview/main.ts");
    expect(main).toMatch(/if \(!options\.length\)[\s\S]*?No models discovered\.[\s\S]*?Dext: Configure Agent/);
  });

  it("opens the complete API list in an editor tab with search, grouping and detail", async () => {
    const html = await source("src/app/sidebarProvider.ts");
    const main = await source("src/webview/main.ts");
    const documents = await source("src/features/resources/presentation/resourceDocuments.ts");
    // The sidebar dialog is gone: the API list is an editor tab now.
    expect(html).not.toContain('id="reload-methods"');
    expect(main).not.toContain("renderMethods");
    expect(main).not.toContain("methodsDialog");
    expect(documents).toContain("renderResourceList");
    expect(documents).toContain("data-resource-search");
    expect(documents).toContain("data-resource-group");
    expect(documents).toContain("data-resource-open");
    expect(documents).toContain("openResourceSource");
    expect(documents).toContain("insertResourceReference");
    expect(documents).toContain("groupResourceEntries");
  });

});
