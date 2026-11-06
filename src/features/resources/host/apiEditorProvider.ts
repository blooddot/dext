import type { ResourceEditorProviderOptions } from "../contracts/resourceDocuments.js";
import { ResourceBrowserProvider } from "./resourceBrowserProvider.js";

/** The API directory and its definitions share one navigable editor tab. */
export class ApiEditorProvider extends ResourceBrowserProvider {
  constructor(options: ResourceEditorProviderOptions) {
    super(options, "api");
  }
}
