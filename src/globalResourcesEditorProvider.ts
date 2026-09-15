import type { ResourceEditorProviderOptions } from "./resourceDocuments.js";
import { ResourceBrowserProvider } from "./resourceBrowserProvider.js";
import type { ResourceKind } from "./resourceSession.js";
import { renderGlobalResources } from "./webview/globalResourcesPanel.js";

/**
 * Global Resources as an editor tab. Categories, refresh, and the existing resource operations are
 * preserved; projects route rule and skill edits through the existing resource flows.
 */
export class GlobalResourcesEditorProvider extends ResourceBrowserProvider {
  constructor(options: ResourceEditorProviderOptions, protected readonly kinds: readonly ResourceKind[] = ["mcp", "rule", "skill"]) {
    super({ renderList: renderGlobalResources, ...options }, "globalResources");
  }

  protected override listKinds(): readonly ResourceKind[] {
    return this.kinds;
  }

  protected override groupBy(): "directory" | "kind" {
    // The Global Resources page keeps its category layout instead of directory nesting.
    return "kind";
  }

  get resourceKinds(): readonly ResourceKind[] {
    return this.kinds;
  }

  protected override primaryKind(): ResourceKind {
    return this.kinds[0] ?? "mcp";
  }
}
