export type MethodKind = "command" | "skill";
export type MethodSource = "builtin" | "global" | "project";
export type OutputKind =
  | "chat"
  | "explain"
  | "edit"
  | "review"
  | "apply"
  | "terminal"
  | "print"
  | "text"
  | "code"
  | "plan"
  | "patch";

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
  | CodeRef
  | PatchResult
  | InvocationValue[];

export type WorkflowScalar = string | number | boolean;

export type WorkflowExpression =
  | { kind: "literal"; value: WorkflowScalar; from: number; to: number }
  | { kind: "list"; values: WorkflowExpression[]; from: number; to: number }
  | { kind: "reference"; reference: ContextReference; from: number; to: number }
  | { kind: "variable"; name: string; from: number; to: number }
  | { kind: "member"; object: WorkflowExpression; property: string; from: number; to: number };

export interface WorkflowCall {
  kind: "call";
  method: string;
  arguments: { name: string; value: WorkflowExpression; from: number; to: number }[];
  from: number;
  to: number;
}

export type WorkflowCondition =
  | {
      kind: "comparison";
      operator: "==" | "!=";
      left: WorkflowExpression;
      right: WorkflowExpression;
      from: number;
      to: number;
    }
  | { kind: "boolean"; value: WorkflowExpression; from: number; to: number };

export type WorkflowStatement =
  | {
      kind: "step";
      assignment?: string;
      call: WorkflowCall;
      from: number;
      to: number;
    }
  | {
      kind: "if";
      condition: WorkflowCondition;
      consequent: WorkflowStatement[];
      alternate: WorkflowStatement[];
      from: number;
      to: number;
    };

export interface WorkflowProgram {
  kind: "workflow";
  source: string;
  statements: WorkflowStatement[];
}

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

export type FieldType = "string" | "number" | "boolean" | "enum" | "context" | "patch";

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

export type ReviewStatus = "pass" | "warning" | "fail";

export interface ChatResult {
  kind: "chat";
  text: string;
}

export interface ExplainResult {
  kind: "explain";
  text: string;
  files: CodeRef[];
}

export interface EditResult {
  kind: "edit";
  summary: string;
  patch: PatchResult;
  files: CodeRef[];
}

export interface WorkflowReviewResult {
  kind: "review";
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
}

export interface ApplyResult {
  kind: "apply";
  status: "applied" | "unchanged" | "conflict";
  files: CodeRef[];
  summary: string;
}

export type TerminalStatus = "succeeded" | "failed" | "timed_out";

export interface TerminalResult {
  kind: "terminal";
  status: TerminalStatus;
  command: string;
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface PrintResult {
  kind: "print";
  text: string;
  label?: string;
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
  | ChatResult
  | ExplainResult
  | EditResult
  | WorkflowReviewResult
  | ApplyResult
  | TerminalResult
  | PrintResult
  | TextResult
  | CodeResult
  | PlanResult
  | PatchResult;

export interface ResolvedInvocation {
  invocation: InvocationAst;
  method: RegisteredCallable;
  arguments: Record<string, InvocationValue | CodeRef | CodeRef[]>;
  context: CodeRef[];
  metadata: Readonly<ExecutionMetadata>;
}

export interface ExecutionMetadata {
  instruction?: string;
}

export interface RuntimeResponse {
  invocation: InvocationAst;
  method: Pick<RegisteredCallable, "id" | "title" | "kind" | "source">;
  result: DextResult;
  durationMs: number;
  instruction?: string;
}

export interface InputExecutionResponse {
  kind: "workflow";
  executions: RuntimeResponse[];
  steps?: WorkflowStepResponse[];
}

export type ExecutionState = "success" | "failed" | "skipped" | "cancelled";

export interface WorkflowStepResponse {
  assignment?: string;
  method: string;
  state: ExecutionState;
  response?: RuntimeResponse;
  error?: string;
}
