export type MethodKind = "command" | "skill";
export type MethodSource = "builtin" | "global" | "project";
export type OutputKind = "text" | "code" | "review" | "plan" | "patch";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface CodeRef {
  kind: "codeRef";
  uri: string;
  range?: Range;
  symbol?: string;
  documentVersion: number;
  contentHash: string;
  content: string;
}

export type ContextReference =
  | { kind: "selection" }
  | { kind: "activeFile" }
  | { kind: "file"; path: string }
  | { kind: "symbol"; name: string };

export type InvocationValue =
  | string
  | number
  | boolean
  | ContextReference
  | InvocationValue[];

export interface InvocationArgument {
  name: string;
  value: InvocationValue;
}

export interface InvocationAst {
  kind: "invocation";
  method: string;
  arguments: InvocationArgument[];
  source: "code" | "chat";
}

export type FieldType = "string" | "number" | "boolean" | "enum" | "context";

export interface FieldDefinition {
  name: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  values?: string[];
  default?: string | number | boolean;
  multiple?: boolean;
}

export interface CallableDefinition {
  id: string;
  title: string;
  description: string;
  kind: MethodKind;
  version: string;
  input: FieldDefinition[];
  output: {
    kind: OutputKind;
    description?: string;
  };
  context?: ContextReference["kind"][];
  executor: {
    kind: "deterministic";
    handler: string;
  };
}

export interface RegisteredCallable extends CallableDefinition {
  source: MethodSource;
}

export interface TextResult {
  kind: "text";
  text: string;
}

export interface CodeResult {
  kind: "code";
  code: string;
  language: string;
  title?: string;
}

export interface ReviewFinding {
  severity: "error" | "warning" | "info";
  message: string;
  uri?: string;
  line?: number;
}

export interface ReviewResult {
  kind: "review";
  summary: string;
  findings: ReviewFinding[];
}

export interface PlanStep {
  title: string;
  detail?: string;
  status: "pending" | "ready";
}

export interface PlanResult {
  kind: "plan";
  title: string;
  steps: PlanStep[];
}

export interface PatchChange {
  uri: string;
  before: string;
  after: string;
}

export interface PatchResult {
  kind: "patch";
  title: string;
  changes: PatchChange[];
}

export type DextResult =
  | TextResult
  | CodeResult
  | ReviewResult
  | PlanResult
  | PatchResult;

export interface ResolvedInvocation {
  invocation: InvocationAst;
  method: RegisteredCallable;
  arguments: Record<string, InvocationValue | CodeRef | CodeRef[]>;
  context: CodeRef[];
}

export interface RuntimeResponse {
  invocation: InvocationAst;
  method: Pick<RegisteredCallable, "id" | "title" | "kind" | "source">;
  result: DextResult;
  durationMs: number;
}
