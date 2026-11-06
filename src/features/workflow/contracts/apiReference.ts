/** How a member is grouped and labelled. A function and a method are both
 * callable, and an interface, type and enum are all types. */
export type ApiReferenceKind =
  | "function"
  | "method"
  | "class"
  | "constructor"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable";

export interface ApiReferenceParam {
  name: string;
  text: string;
}

export interface ApiReferenceMember {
  name: string;
  kind: ApiReferenceKind;
  /** The declaration's own signature, one line per overload. */
  signature: string;
  documentation?: string;
  deprecated?: string;
  returns?: string;
  example?: string;
  params?: readonly ApiReferenceParam[];
  members?: readonly ApiReferenceMember[];
}

export interface ApiReferenceModule {
  /** The specifier of a Node module (`node:fs/promises`), or `js.<global>`. */
  id: string;
  family: "node" | "js";
  /** The short name the tree shows: `fs/promises`, `JSON`. */
  name: string;
  documentation?: string;
  members: readonly ApiReferenceMember[];
}

export interface ApiReferenceCatalog {
  version: number;
  typescript: string;
  modules: readonly ApiReferenceModule[];
}

/** A documented exported function read from workspace source. */
export interface ApiSourceFunction {
  name: string;
  description?: string;
  api: {
    signature: string;
    typeParameters?: string;
    parameters: Array<{ name: string; type: string; required: boolean; defaultValue?: string; description?: string }>;
    returnType: string;
  };
}
