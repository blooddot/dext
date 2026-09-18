import { renderResourceList, type ResourceListDocument, type ResourcePanelOptions } from "../resourceDocuments.js";
import { RESOURCE_LABELS } from "../resourceSession.js";

/**
 * Global Resources page. Categories, search, refresh and source jumps are preserved from the
 * removed sidebar dialog; creating or editing a resource routes into the existing edit flow.
 * Each category nests its own namespaces the same way the API page does.
 */
export function renderGlobalResources(document: ResourceListDocument, options: ResourcePanelOptions = {}): string {
  const kinds = options.createKinds ?? ["mcp", "rule", "skill"];
  const groups = kinds.map((kind) => ({
    label: RESOURCE_LABELS[kind],
    entries: document.groups.find((group) => group.label === RESOURCE_LABELS[kind])?.entries ?? []
  }));
  return renderResourceList({ ...document, groups }, { ...options, title: options.title ?? "Global Resources", createKinds: kinds, categoryTree: true });
}
