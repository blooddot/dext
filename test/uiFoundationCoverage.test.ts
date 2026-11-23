import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it, vi } from "vitest";
import type { DextApplication } from "../src/app/application.js";
import { DextSidebarProvider } from "../src/app/sidebarProvider.js";
import type { ResourceSession } from "../src/features/resources/contracts/resourceSession.js";
import type { ApiFlow } from "../src/features/workflow/contracts/apiFlow.js";
import { EDITOR_TAB_VIEW_TYPES } from "../src/platform/editor-tabs/editorTabTypes.js";
import type { WebviewResponse } from "../src/platform/webviewProtocol.js";
import { htmlUiAdapter } from "../src/shared/lib/ui/htmlUiAdapter.js";
import { Trace, TraceCollapsible, TraceCollapsibleTrigger, TraceLine } from "../src/shared/lib/ui/content/traceComponents.js";
import { Form, Input } from "../src/shared/lib/ui/input/formComponents.js";
import { Button, Label } from "../src/shared/lib/ui/input/nativeControls.js";
import { Dialog } from "../src/shared/lib/ui/overlay/dialog.js";

const createWebviewPanel = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({
  select: vi.fn(), command: vi.fn(), clipboard: vi.fn(), editor: vi.fn(), output: vi.fn(), appendLine: vi.fn()
}));
vi.mock("vscode", () => ({
  ViewColumn: { Beside: -2 },
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    joinPath: (_: unknown, ...parts: string[]) => ({
      fsPath: parts.join("/"),
      with: ({ query }: { query: string }) => ({ toString: () => `test:/${parts.join("/")}?${query}` })
    })
  },
  window: { createWebviewPanel, showQuickPick: native.select, showTextDocument: native.editor, createOutputChannel: native.output },
  workspace: { getConfiguration: () => ({ get: () => undefined }), fs: {
    readDirectory: async () => [["example.plan.md", 1], ["folder.plan.md", 2], ["other.md", 1]]
  } },
  env: { clipboard: { writeText: native.clipboard } },
  commands: { executeCommand: native.command }
}));

const indexPath = "docs/ui-foundation-coverage.zh-CN.md";

function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

async function readCoverage() {
  const index = await readFile(indexPath, "utf8");
  return index.split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.at(-1)?.startsWith("`"))
    .map((cells) => {
      const isRegistration = cells.length === 6;
      return {
        label: cells[0]!,
        entry: codeSpans(cells[isRegistration ? 0 : 1]!),
        viewType: isRegistration ? codeSpans(cells[1]!)[0] : undefined,
        registration: isRegistration ? codeSpans(cells[2]!)[0] : undefined,
        implementations: codeSpans(cells.at(-3)!),
        route: codeSpans(cells.at(-2)!),
        isImport: cells.at(-2)!.includes(" → "),
        fixtures: codeSpans(cells.at(-1)!)
      };
    });
}

describe("Dext UI coverage index", () => {
  it("tracks each active Webview registration and resolves its registered type", async () => {
    const rows = await readCoverage();
    const registrations = new Map<string, string>();
    const files = (await readdir("src", { recursive: true })).filter((name) => name.endsWith(".ts"));
    for (const file of files) {
      const path = join("src", file).replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      for (const [, method, target] of source.matchAll(/\.(registerWebviewViewProvider|registerWebviewPanelSerializer|createWebviewPanel)\(\s*("[^"\n]+"|[\w.]+)\s*,/g)) {
        const registration = `${method}(${target})`;
        expect(registrations.has(registration), `${registration} in ${path}`).toBe(false);
        registrations.set(registration, path);
      }
    }

    const indexed = rows.filter((row) => row.registration !== undefined);
    expect(indexed.map((row) => row.registration).sort()).toEqual([...registrations.keys()].sort());
    const sidebar = await readFile("src/app/sidebarProvider.ts", "utf8");
    const history = await readFile("src/features/conversations/host/historyEditorProvider.ts", "utf8");
    const types = new Map([
      ["DextSidebarProvider.viewType", sidebar.match(/static readonly viewType = "([^"]+)"/)?.[1]],
      ["DextHistoryPanel.viewType", history.match(/static readonly viewType = "([^"]+)"/)?.[1]],
      ["EDITOR_TAB_VIEW_TYPES.globalResources", EDITOR_TAB_VIEW_TYPES.globalResources],
      ["descriptor.viewType", EDITOR_TAB_VIEW_TYPES.globalResources]
    ]);
    for (const row of indexed) {
      const registration = row.registration!;
      const target = registration.slice(registration.indexOf("(") + 1, -1);
      expect(row.viewType, registration).toBe(target.startsWith('"') ? JSON.parse(target) : types.get(target));
      expect(row.implementations.map((reference) => reference.split("#")[0]), registration)
        .toContain(registrations.get(registration));
    }

    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      contributes: { views: Record<string, Array<{ type: string; id: string }>> };
    };
    const webviews = Object.values(manifest.contributes.views).flat();
    expect(webviews.filter((view) => view.type === "webview").map((view) => view.id).sort())
      .toEqual(indexed.filter((row) => row.registration!.startsWith("registerWebviewViewProvider")).map((row) => row.viewType).sort());
    const extension = await readFile("src/extension.ts", "utf8");
    const commands = new Set([...extension.matchAll(/\.registerCommand\("([^"]+)"/g)].map((match) => match[1]));
    for (const row of rows) {
      for (const id of row.entry) {
        if (!indexed.some((view) => view.viewType === id)) expect(commands.has(id), row.label).toBe(true);
      }
    }
  });

  it("points each indexed surface to its implementation and existing regression fixtures", async () => {
    const rows = await readCoverage();
    expect(rows.length).toBeGreaterThan(0);
    for (const { label, implementations, fixtures } of rows) {
      expect(implementations, label).not.toHaveLength(0);
      expect(fixtures, label).not.toHaveLength(0);
      for (const reference of implementations) {
        const [path, anchor] = reference.split("#");
        const source = await readFile(path!, "utf8");
        if (anchor) expect(source, `${label}: ${reference}`).toContain(anchor);
      }
      for (const fixture of fixtures) {
        expect(fixture, label).toMatch(/^(test\/.+\.test\.ts|scripts\/.+\.mjs)$/);
        expect(await readFile(fixture, "utf8"), `${label}: ${fixture}`).not.toBe("");
      }
    }
  });

  it("resolves every indexed component or native host call", async () => {
    for (const { label, route, isImport } of await readCoverage()) {
      expect(route, label).not.toHaveLength(0);
      if (isImport) {
        const [caller, reference] = route;
        const [target, symbol] = reference!.split("#");
        const source = await readFile(caller!, "utf8");
        const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)];
        expect(imports.some(([, names, path]) => names!.split(/[\s,]+/).includes(symbol!)
          && resolve(dirname(caller!), path!.replace(/\.js$/, ".ts")) === resolve(target!)), `${label}: ${reference}`).toBe(true);
        expect((source.match(new RegExp(`\\b${symbol}\\b`, "g")) ?? []).length, label).toBeGreaterThan(1);
        expect(await readFile(target!, "utf8"), label).toContain(symbol);
      } else {
        for (const reference of route) {
          const [path, call] = reference.split("#");
          expect(await readFile(path!, "utf8"), label).toContain(call);
        }
      }
    }
  });
});

type ParsedElement = DefaultTreeAdapterTypes.Element;

function childElements(node: DefaultTreeAdapterTypes.ParentNode): ParsedElement[] {
  return node.childNodes.filter((child): child is ParsedElement => "tagName" in child);
}

function attribute(node: ParsedElement, name: string): string | undefined {
  return node.attrs.find((entry) => entry.name === name)?.value;
}

function hasText(node: ParsedElement): boolean {
  return node.childNodes.some((child) => ("value" in child && Boolean(child.value.trim()))
    || ("tagName" in child && hasText(child)));
}

describe("Dext UI component composition", () => {
  // These fixtures exercise the component contract before wiring each page to it.
  const form = Form(htmlUiAdapter, "Settings", [
    Label(htmlUiAdapter, { for: "scope" }, ["Scope"]),
    Input(htmlUiAdapter, { id: "scope" }),
    Button(htmlUiAdapter, { type: "submit", disabled: true }, ["Save"])
  ]);
  const cases: Array<{
    name: string;
    markup: string;
    invalid: [string, string];
    valid: (root: ParsedElement) => boolean;
  }> = [
    {
      name: "Form",
      markup: form.html,
      invalid: ['for="scope"', 'for="missing"'],
      valid(form) {
        const [label, field, submit] = childElements(form);
        return form.tagName === "form" && Boolean(attribute(form, "aria-label"))
          && label?.tagName === "label" && hasText(label)
          && field?.tagName === "input" && Boolean(attribute(field, "id"))
          && attribute(label, "for") === attribute(field, "id")
          && submit?.tagName === "button" && attribute(submit, "type") === "submit"
          && attribute(submit, "disabled") === "";
      }
    },
    {
      name: "Dialog",
      markup: Dialog(htmlUiAdapter, { labelledBy: "settings" }, [
        htmlUiAdapter.element("h3", { id: "settings" }, ["Settings"]),
        form
      ]).html,
      invalid: ['aria-labelledby="settings"', 'aria-labelledby="missing"'],
      valid(dialog) {
        const [title, body] = childElements(dialog);
        return dialog.tagName === "dialog" && attribute(dialog, "open") === undefined
          && title?.tagName === "h3" && hasText(title) && Boolean(attribute(title, "id"))
          && attribute(dialog, "aria-labelledby") === attribute(title, "id")
          && body?.tagName === "form" && childElements(dialog).filter((child) => child.tagName === "form").length === 1;
      }
    },
    {
      name: "Tabs",
      markup: '<div><div role="tablist" aria-label="Resources"><button role="tab" aria-selected="true" aria-controls="project" id="project-tab">Project</button><button aria-label="Close project">×</button></div><div role="tabpanel" id="project" aria-labelledby="project-tab"></div></div>',
      invalid: ['aria-labelledby="project-tab"', 'aria-labelledby="other-tab"'],
      valid(tabs) {
        const [list, panel] = childElements(tabs);
        if (!list || !panel) return false;
        const selected = childElements(list).filter((child) => attribute(child, "role") === "tab" && attribute(child, "aria-selected") === "true");
        const action = childElements(list).find((child) => child.tagName === "button" && attribute(child, "role") === undefined);
        const tab = selected[0];
        return attribute(list, "role") === "tablist" && Boolean(attribute(list, "aria-label"))
          && selected.length === 1 && tab !== undefined && hasText(tab)
          && attribute(tab, "aria-controls") === attribute(panel, "id") && attribute(panel, "role") === "tabpanel"
          && attribute(panel, "aria-labelledby") === attribute(tab, "id")
          && Boolean(action && attribute(action, "aria-label"));
      }
    },
    {
      name: "Menu",
      markup: '<div><button aria-controls="choices" aria-expanded="true">Mode</button><div role="menu" id="choices"><button role="menuitemradio" aria-checked="true">Code</button><button role="menuitem" tabindex="-1" disabled>Agent</button><p>Unavailable modes</p></div></div>',
      invalid: ["<p>", '<p role="menuitem">'],
      valid(menu) {
        const [trigger, list] = childElements(menu);
        if (!trigger || !list) return false;
        const [selected, disabled, empty] = childElements(list);
        return trigger.tagName === "button" && hasText(trigger) && attribute(trigger, "aria-expanded") === "true"
          && attribute(trigger, "aria-controls") === attribute(list, "id") && attribute(list, "role") === "menu"
          && selected !== undefined && attribute(selected, "role") === "menuitemradio" && attribute(selected, "aria-checked") === "true"
          && disabled !== undefined && attribute(disabled, "disabled") === "" && attribute(disabled, "tabindex") === "-1"
          && empty?.tagName === "p" && hasText(empty) && attribute(empty, "role") === undefined;
      }
    },
    {
      name: "Trace",
      markup: Trace(htmlUiAdapter, [
        TraceLine(htmlUiAdapter, [TraceCollapsible(htmlUiAdapter, TraceCollapsibleTrigger(htmlUiAdapter, ["Process"]), ["Notes"])])
      ]).html,
      invalid: ["<summary>Process</summary>Notes", "<p>Notes</p><summary>Process</summary>"],
      valid(trace) {
        const rows = childElements(trace);
        const details = rows[0] && childElements(rows[0])[0];
        const trigger = details && childElements(details)[0];
        return trace.tagName === "ul" && rows.length === 1 && rows.every((row) => row.tagName === "li")
          && details?.tagName === "details" && attribute(details, "open") === undefined
          && trigger?.tagName === "summary" && hasText(trigger);
      }
    }
  ];
  it.each(cases)("$name observes the minimum accessible parts and rejects the invalid shape", ({ markup, invalid, valid }) => {
    const root = (source: string) => childElements(parseFragment(source))[0]!;
    expect(markup).toContain(invalid[0]);
    expect(valid(root(markup))).toBe(true);
    expect(valid(root(markup.replace(...invalid)))).toBe(false);
  });
});

function sidebarFor(resource?: ResourceSession) {
  const session = { id: "active", resource };
  const post = vi.fn<(message: WebviewResponse) => Promise<void>>(async () => {});
  const abortTurn = vi.fn();
  const application = {
    apiFlow: vi.fn<(content: string, entryName?: string) => Promise<ApiFlow>>(),
    generateMcpManifest: vi.fn<DextApplication["generateMcpManifest"]>(),
    discoverMcpTools: vi.fn(),
    createMcpManifest: vi.fn()
  };
  const sidebar = Object.create(DextSidebarProvider.prototype) as { receive(raw: unknown): Promise<void> };
  Object.assign(sidebar, {
    application,
    extensionUri: {},
    appearance: { current: "dark" },
    conversation: {
      controller: { active: () => session, session: (id: string) => id === session.id ? session : undefined },
      coordinator: { abortTurn, running: () => false }
    },
    resourceOperations: new Set<string>(),
    post,
    postWhenReady: post,
    refresh: vi.fn(),
    updateRunningContext: vi.fn()
  });
  return { sidebar, application, post, abortTurn };
}

describe("sidebar Webview baselines", () => {
  it("delegates native selection, editor, diff, clipboard and output calls to the host", async () => {
    const { sidebar, post } = sidebarFor();
    const setActivePlan = vi.fn();
    Object.assign(sidebar, {
      application: { storage: { globalStorageUri: {} }, dextTypesPath: () => "dist/dext.d.ts" },
      conversation: { controller: { hydrate: vi.fn() } },
      setActivePlan
    });
    native.select.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ reference: ".dext-global/plans/example.plan.md" });
    await sidebar.receive({ type: "choosePlan" });
    expect(setActivePlan).not.toHaveBeenCalled();
    await sidebar.receive({ type: "choosePlan" });
    expect(native.select).toHaveBeenLastCalledWith([
      expect.objectContaining({ label: "$(add) New plan" }),
      { label: "example.plan.md", description: ".dext-global/plans", reference: ".dext-global/plans/example.plan.md" }
    ], expect.objectContaining({ title: "Select a Dext plan" }));
    expect(setActivePlan).toHaveBeenCalledExactlyOnceWith(".dext-global/plans/example.plan.md");

    await sidebar.receive({ type: "openBuiltinApiDefinition", id: "ui.render" });
    expect(native.editor).toHaveBeenCalledExactlyOnceWith({ fsPath: "dist/dext.d.ts" }, { preview: true });
    await sidebar.receive({ type: "openTurnDiff", sessionId: "active", turnId: "turn", path: "src/example.ts" });
    expect(native.command).toHaveBeenCalledExactlyOnceWith("dext.history.openTurnDiff", {
      sessionId: "active", turnId: "turn", path: "src/example.ts"
    });

    await sidebar.receive({ type: "clipboardWrite", requestId: 9, text: "exact\r\nline" });
    expect(native.clipboard).toHaveBeenCalledExactlyOnceWith("exact\r\nline");
    expect(post).toHaveBeenCalledWith({ type: "clipboardWriteResult", requestId: 9, success: true });
    native.output.mockReturnValue({ appendLine: native.appendLine });
    await sidebar.receive({ type: "composerTypesApplied", builtins: 4, modules: 2 });
    await sidebar.receive({ type: "composerTypesApplied", builtins: 4, modules: 3 });
    expect(native.output).toHaveBeenCalledExactlyOnceWith("Dext Input");
    expect(native.appendLine.mock.calls).toEqual([
      ["[composer] applied by the input: 4 built-in name(s), 2 API module(s)"],
      ["[composer] applied by the input: 4 built-in name(s), 3 API module(s)"]
    ]);
  });

  it("opens the read-only API draft preview with ordered files and local flow assets", async () => {
    const resource: ResourceSession = {
      type: "api", scope: "project",
      draft: {
        name: "demo",
        content: 'export function demo() { return "<draft>"; }',
        files: [
          { path: "rules/z.md", content: "Z <unsafe>" },
          { path: "templates/a.md", content: "A & B" }
        ]
      }
    };
    const { sidebar, application, post } = sidebarFor(resource);
    application.apiFlow.mockResolvedValue({
      functions: [{ name: "demo", line: 1, exported: true, calls: [], apiCalls: [], unused: false }],
      edges: [],
      issues: []
    });
    const panel = {
      title: "", reveal: vi.fn(), onDidDispose: vi.fn(),
      webview: { cspSource: "test:", html: "", asWebviewUri: (uri: unknown) => uri }
    };
    createWebviewPanel.mockClear();
    createWebviewPanel.mockReturnValue(panel);
    const request = { type: "previewResource", sessionId: "active" };
    await sidebar.receive(request);
    expect(createWebviewPanel).toHaveBeenCalledWith("dext.resourcePreview", "Dext Preview", -2, {
      enableScripts: true, localResourceRoots: [{}]
    });
    expect(application.apiFlow).toHaveBeenCalledWith(resource.draft!.content, "demo");
    expect(panel.title).toBe("Dext Preview: demo");
    const { html } = panel.webview;
    expect(html).toContain('data-dext-theme="dark"');
    expect(html).toContain('<h2>.dext/api/demo.ts</h2><span class="resource-source">Draft</span>');
    expect(html.match(/<h3 class="resource-source-heading">[^<]+<\/h3>/g)).toEqual([
      '<h3 class="resource-source-heading">Source</h3>',
      '<h3 class="resource-source-heading">.dext/rules/z.md</h3>',
      '<h3 class="resource-source-heading">.dext/templates/a.md</h3>'
    ]);
    expect(html).toContain("Z &lt;unsafe&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toMatch(/data-api-flow[\s\S]*<h3 class="resource-source-heading">Source/);
    expect(html).toMatch(/script-src 'nonce-([a-f\d]+)'[\s\S]*<script nonce="\1" src="test:\/dist\/webview\/apiFlow\.js\?v=/);
    expect(html).not.toMatch(/data-resource-(?:command|open|navigate)|<textarea/);
    expect(post).toHaveBeenLastCalledWith({ type: "resourceContext", sessionId: "active", resource });

    await sidebar.receive(request);
    expect(createWebviewPanel).toHaveBeenCalledOnce();
    expect(panel.reveal).toHaveBeenCalledTimes(2);
  });

  it("stops only the matching MCP generation and reports its request completion", async () => {
    const { sidebar, application, post, abortTurn } = sidebarFor();
    const progress = { phase: "status" as const, text: "Reading documentation" };
    let signal: AbortSignal | undefined;
    application.generateMcpManifest.mockImplementation((_document, options) => {
      if (!options?.signal || !options.onAgentEvent) throw new Error("Expected signal and progress callback");
      const { signal: activeSignal, onAgentEvent } = options;
      signal = activeSignal;
      onAgentEvent(progress);
      return new Promise((_resolve, reject) => {
        activeSignal.addEventListener("abort", () => reject(new Error("Generation cancelled.")), { once: true });
      });
    });
    const pending = sidebar.receive({ type: "generateMcp", requestId: "mcp-1", document: "Example documentation" });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: "mcpProgress", requestId: "mcp-1", event: progress }));
    await sidebar.receive({ type: "stopExecution", turnId: "other" });
    expect(signal?.aborted).toBe(false);
    await sidebar.receive({ type: "stopExecution", turnId: "mcp-1" });
    await pending;
    expect(abortTurn).toHaveBeenLastCalledWith("mcp-1");
    expect(signal?.aborted).toBe(true);
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: "executing", sessionId: "active", value: true, turnId: "mcp-1", source: "Add MCP with AI" },
      { type: "mcpProgress", requestId: "mcp-1", event: progress },
      { type: "executing", sessionId: "active", value: false, turnId: "mcp-1" },
      { type: "error", message: "Generation cancelled." }
    ]);
    expect(application.discoverMcpTools).not.toHaveBeenCalled();
    expect(application.createMcpManifest).not.toHaveBeenCalled();
  });

  it("discovers MCP tools for the draft and saves the selected tools in the requested scope", async () => {
    const { sidebar, application, post } = sidebarFor();
    const server = { name: "docs", transport: "http" as const, url: "https://example.test/mcp" };
    const tools = [{ name: "read" }, { name: "search" }];
    application.generateMcpManifest.mockResolvedValue(server);
    application.discoverMcpTools.mockResolvedValue(tools);
    await sidebar.receive({ type: "generateMcp", requestId: "draft", document: "Example documentation" });
    expect(post).toHaveBeenCalledWith({ type: "mcpGenerated", requestId: "draft", server });
    expect(post).toHaveBeenCalledWith({ type: "mcpToolsDiscovered", requestId: "draft", tools });
    await sidebar.receive({ type: "prepareMcp", requestId: "review", scope: "global", server });
    expect(application.discoverMcpTools).toHaveBeenLastCalledWith({ ...server, scope: "global" });
    expect(post).toHaveBeenLastCalledWith({ type: "mcpToolsDiscovered", requestId: "review", tools });
    await sidebar.receive({ type: "createMcp", scope: "global", selectedTools: ["read"], server });
    expect(application.createMcpManifest).toHaveBeenCalledExactlyOnceWith(server, "global", ["read"]);
    expect(post).toHaveBeenLastCalledWith({ type: "mcpCreated", name: "docs" });
  });
});
