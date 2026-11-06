import { type ResourceDefinitionDocument, type ResourceListDocument, type ResourcePanelOptions } from "../contracts/resourceDocuments.js";
import { renderResourceDefinition, renderResourceList } from "./resourceDocuments.js";

/**
 * API list page. Search, namespace grouping, detail, reference insertion and source jumps are the
 * same operations the removed sidebar dialog offered.
 */
export function renderApiList(document: ResourceListDocument, options: ResourcePanelOptions = {}): string {
  return renderResourceList(document, { ...options, apiTree: true });
}

export function renderApiDetail(document: ResourceDefinitionDocument, options: ResourcePanelOptions = {}): string {
  return renderResourceDefinition(document, options);
}
