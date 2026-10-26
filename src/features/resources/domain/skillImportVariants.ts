/** Import-time choices. The installed files belong to Dext; this does not route
 * conversations or activate the source repository's native plugins. */
export interface ImportVariantSource {
  path: string;
  agent: string;
}

export interface ImportTargetRequest {
  recommended: string;
  targets: string[];
  sources: ImportVariantSource[];
}

export interface ImportVariantRequest {
  kind: "skill" | "command";
  id: string;
  targetAgent: string;
  sources: ImportVariantSource[];
}

export interface ImportVariantOptions {
  /** An explicit import choice, independent of the conversation's Agent. */
  targetAgent?: string;
  /** Used only to recommend a target in the picker. */
  preferredAgent?: string;
  chooseTarget?: (request: ImportTargetRequest) => Promise<string | undefined>;
  chooseVariant?: (request: ImportVariantRequest) => Promise<string | undefined>;
}
