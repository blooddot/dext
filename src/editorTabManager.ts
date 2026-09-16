import { editorTabTitle, type EditorTabKind } from "./editorTabTypes.js";

export interface EditorTabDescriptorLike {
  key: string;
  kind: EditorTabKind;
  viewType: string;
  title: string;
  resourceLabel?: string;
}

export interface EditorTabPanelHandle {
  reveal(column?: unknown): void;
  dispose(): void;
  setHtml?(html: string): void;
  postMessage?(message: unknown): void;
}

export interface EditorTabCallbacks {
  onDispose(): void;
  onMessage(message: unknown): void;
}

export interface EditorTabHost {
  createPanel(descriptor: EditorTabDescriptorLike, callbacks: EditorTabCallbacks): EditorTabPanelHandle;
}

export interface OpenEditorTabResult {
  key: string;
  created: boolean;
  panel: EditorTabPanelHandle;
}

interface TabRecord {
  descriptor: EditorTabDescriptorLike;
  panel: EditorTabPanelHandle;
}

/**
 * Owns one webview panel per stable key. Opening the same key again reveals the existing panel
 * instead of creating a duplicate, and closing a panel releases the key without touching data.
 */
export class EditorTabManager {
  private readonly tabs = new Map<string, TabRecord>();

  constructor(
    private readonly host: EditorTabHost,
    private readonly onMessage: (key: string, message: unknown) => void = () => {}
  ) {}

  open(descriptor: EditorTabDescriptorLike): OpenEditorTabResult {
    const existing = this.tabs.get(descriptor.key);
    if (existing) {
      existing.panel.reveal();
      return { key: descriptor.key, created: false, panel: existing.panel };
    }
    const panel = this.host.createPanel(descriptor, {
      onDispose: () => this.close(descriptor.key),
      onMessage: (message) => this.onMessage(descriptor.key, message)
    });
    this.tabs.set(descriptor.key, { descriptor, panel });
    return { key: descriptor.key, created: true, panel };
  }

  has(key: string): boolean {
    return this.tabs.has(key);
  }

  /**
   * Registers a panel the manager did not create, such as one VS Code restored from a webview
   * serializer. A key that is already open keeps its existing panel and the incoming panel is
   * disposed, so a serializer restore and a proactive restore cannot double-open the same tab.
   */
  adopt(key: string, descriptor: EditorTabDescriptorLike, panel: EditorTabPanelHandle): OpenEditorTabResult {
    const existing = this.tabs.get(key);
    if (existing) {
      panel.dispose();
      existing.panel.reveal();
      return { key, created: false, panel: existing.panel };
    }
    this.tabs.set(key, { descriptor, panel });
    return { key, created: true, panel };
  }

  /** Routes a message from an adopted panel through the same handler as managed panels. */
  receive(key: string, message: unknown): void {
    if (!this.tabs.has(key)) return;
    this.onMessage(key, message);
  }

  get(key: string): EditorTabDescriptorLike | undefined {
    return this.tabs.get(key)?.descriptor;
  }

  get activeKeys(): string[] {
    return [...this.tabs.keys()].sort();
  }

  /** Reveals an already open tab. Returns false when nothing is open for the key. */
  reveal(key: string): boolean {
    const record = this.tabs.get(key);
    if (!record) return false;
    record.panel.reveal();
    return true;
  }

  close(key: string): boolean {
    const record = this.tabs.get(key);
    if (!record) return false;
    this.tabs.delete(key);
    record.panel.dispose();
    return true;
  }

  /**
   * Closes a key only while `panel` is the one registered for it. A panel VS Code restored passes
   * its own dispose callback through {@link adopt}, and adopting a key that is already open disposes
   * that incoming panel; without this guard the callback would then close the live tab.
   */
  closeIfCurrent(key: string, panel: EditorTabPanelHandle): boolean {
    const record = this.tabs.get(key);
    if (!record || record.panel !== panel) return false;
    return this.close(key);
  }

  closeAll(): void {
    for (const key of [...this.tabs.keys()]) this.close(key);
  }

  dispose(): void {
    this.closeAll();
  }
}

export interface VscodeWebviewPanelLike {
  reveal?(column?: unknown): void;
  dispose(): void;
  onDidDispose(listener: () => void): void;
  webview: {
    html: string;
    onDidReceiveMessage(listener: (message: unknown) => void): void;
  };
}

export interface VscodeWindowLike {
  createWebviewPanel(viewType: string, title: string, column: unknown, options: unknown): VscodeWebviewPanelLike;
}

export interface EditorTabHostOptions {
  column?: unknown;
  localResourceRoots?: unknown[];
  retainContextWhenHidden?: boolean;
  renderHtml?: (panel: VscodeWebviewPanelLike, body: string) => string;
}

/** Adapts one existing VS Code webview panel, including a panel restored by a serializer. */
export function wrapVscodeWebviewPanel(panel: VscodeWebviewPanelLike, callbacks: EditorTabCallbacks, renderHtml?: EditorTabHostOptions["renderHtml"]): EditorTabPanelHandle {
  panel.onDidDispose(() => callbacks.onDispose());
  panel.webview.onDidReceiveMessage((message) => callbacks.onMessage(message));
  return {
    reveal: (column?: unknown) => panel.reveal?.(column),
    dispose: () => panel.dispose(),
    setHtml: (html: string) => { panel.webview.html = renderHtml ? renderHtml(panel, html) : html; },
    postMessage: (message: unknown) => {
      const webview = panel.webview as { postMessage?: (value: unknown) => void };
      webview.postMessage?.(message);
    }
  };
}

/** Adapts a VS Code window into an {@link EditorTabHost} without importing vscode here. */
export function createVscodeEditorTabHost(windowApi: VscodeWindowLike, options: EditorTabHostOptions = {}): EditorTabHost {
  return {
    createPanel(descriptor, callbacks) {
      const panel = windowApi.createWebviewPanel(descriptor.viewType, descriptor.title, options.column ?? -1, {
        enableScripts: true,
        retainContextWhenHidden: options.retainContextWhenHidden ?? true,
        ...(options.localResourceRoots ? { localResourceRoots: options.localResourceRoots } : {})
      });
      return wrapVscodeWebviewPanel(panel, callbacks, options.renderHtml);
    }
  };
}

/** Convenience descriptor builder so every caller derives the same stable key and title. */
export function describeEditorTab(kind: EditorTabKind, key: string, viewType: string, resourceLabel?: string): EditorTabDescriptorLike {
  return { key, kind, viewType, title: editorTabTitle(kind, resourceLabel), ...(resourceLabel ? { resourceLabel } : {}) };
}
