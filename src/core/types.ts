export type MethodKind = "command" | "skill";
export type MethodSource = "builtin" | "global" | "project";
export type BuiltinOutputKind =
  | "chat"
  | "agent"
  | "explain"
  | "edit"
  | "review"
  | "apply"
  | "terminal"
  | "print"
  | "text"
  | "code"
  | "plan"
  | "patch"
  | "ui"
  | "mcpRaw";

/** Custom .dx TypedDict results use their Literal kind without adding a new
 * language keyword or pretending their values are class instances. */
export type OutputKind = BuiltinOutputKind | (string & {});

/** Common structural contract shared by every value returned from a Dext API. */
export interface DextResultBase {
  kind: string;
}

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

/** A workspace-contained directory reference. It deliberately contains no
 * directory contents, so passing a directory never expands the prompt. */
export interface DirRef {
  kind: "dirRef";
  uri: string;
  path: string;
}

export type ContextReference =
  | { kind: "selection" }
  | { kind: "activeFile" }
  | { kind: "file"; path: string }
  | { kind: "symbol"; name: string };

export interface DirectoryReference {
  kind: "dir";
  path: string;
}

export type InvocationValue =
  | string
  | number
  | boolean
  | ContextReference
  | DirectoryReference
  | DirRef
  | CodeRef
  | DextResultBase
  | InvocationValue[]
  | { [key: string]: InvocationValue };

export type WorkflowScalar = string | number | boolean;

export type WorkflowExpression =
  | { kind: "literal"; value: WorkflowScalar; from: number; to: number }
  | { kind: "list"; values: WorkflowExpression[]; from: number; to: number }
  | { kind: "object"; entries: { key: string; value: WorkflowExpression; from: number; to: number }[]; from: number; to: number }
  | { kind: "reference"; reference: ContextReference | DirectoryReference; from: number; to: number }
  | { kind: "variable"; name: string; from: number; to: number }
  | { kind: "member"; object: WorkflowExpression; property: string; from: number; to: number }
  | { kind: "call"; call: WorkflowCall; from: number; to: number }
  | {
    kind: "format";
    parts: ({ kind: "text"; text: string } | { kind: "expression"; expression: WorkflowExpression })[];
    from: number;
    to: number;
  };


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
  returnExpression?: WorkflowExpression;
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

export type FieldType = "string" | "number" | "boolean" | "object" | "enum" | "context" | "dir" | "result";

export interface FieldDefinition {
  name: string;
  type: FieldType;
  accepts?: FieldType[];
  description?: string;
  required?: boolean;
  values?: string[];
  default?: string | number | boolean | { [key: string]: never };
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
    /** Fields declared by a restricted Python TypedDict result. */
    fields?: FieldDefinition[];
    resultType?: string;
  };
  context?: ContextReference["kind"][];
  executor: {
    kind: "deterministic";
    handler: string;
  } | {
    kind: "custom";
    apiId: string;
  };
}

export interface CustomApiPlan {
  id: string;
  sourcePath: string;
  parameters: string[];
  program: WorkflowProgram;
  returnExpression: WorkflowExpression;
  agent?: string;
  model?: string;
}

export interface RegisteredCallable extends CallableDefinition {
  source: MethodSource;
}

export interface TextResult extends DextResultBase {
  kind: "text";
  text: string;
}

export interface CodeResult extends DextResultBase {
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

export interface ChatResult extends DextResultBase {
  kind: "chat";
  text: string;
}

/** Result of a continuous agent task. A patch is present when the Agent
 * generated an auditable edit proposal, including every apply=false edit. */
export interface AgentResult extends DextResultBase {
  kind: "agent";
  text: string;
  summary?: string;
  patch?: PatchResult;
  files?: CodeRef[];
}

export interface ExplainResult extends DextResultBase {
  kind: "explain";
  text: string;
  files: CodeRef[];
}

export interface EditResult extends DextResultBase {
  kind: "edit";
  summary: string;
  patch: PatchResult;
  files: CodeRef[];
}

export interface WorkflowReviewResult extends DextResultBase {
  kind: "review";
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
}

export interface ApplyResult extends DextResultBase {
  kind: "apply";
  status: "applied" | "unchanged" | "conflict";
  files: CodeRef[];
  summary: string;
}

export type TerminalStatus = "succeeded" | "failed" | "timed_out";

export interface TerminalResult extends DextResultBase {
  kind: "terminal";
  status: TerminalStatus;
  command: string;
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface PrintResult extends DextResultBase {
  kind: "print";
  text: string;
  label?: string;
}

export interface UiChoiceResult extends DextResultBase {
  kind: "ui";
  type: "choice";
  selected: string[];
  custom?: string;
}

export interface UiConfirmResult extends DextResultBase {
  kind: "ui";
  type: "confirm";
  confirmed: boolean;
}

export interface UiInputResult extends DextResultBase {
  kind: "ui";
  type: "input";
  value?: string;
}

export type UiResult = UiChoiceResult | UiConfirmResult | UiInputResult;

/** Raw result of an MCP tools/call request. TypedDict custom APIs adapt only
 * the structured payload into domain-specific result kinds. */
export interface McpRawResult extends DextResultBase {
  kind: "mcpRaw";
  server: string;
  tool: string;
  content?: string;
  structured?: Record<string, unknown>;
}

export interface PlanStep {
  title: string;
  detail?: string;
  status: "pending" | "ready";
}

export interface PlanResult extends DextResultBase {
  kind: "plan";
  title: string;
  steps: PlanStep[];
}

export interface PatchChange {
  uri: string;
  before: string;
  after: string;
  range?: Range;
  documentVersion?: number;
  contentHash?: string;
}

export interface PatchResult extends DextResultBase {
  kind: "patch";
  title: string;
  changes: PatchChange[];
}

export type DextResult =
  | ChatResult
  | AgentResult
  | ExplainResult
  | EditResult
  | WorkflowReviewResult
  | ApplyResult
  | TerminalResult
  | PrintResult
  | TextResult
  | CodeResult
  | PlanResult
  | PatchResult
  | UiResult
  | McpRawResult;

export interface ResolvedInvocation {
  invocation: InvocationAst;
  method: RegisteredCallable;
  arguments: Record<string, InvocationValue | CodeRef | CodeRef[] | DirRef>;
  context: CodeRef[];
  metadata: Readonly<ExecutionMetadata>;
}

export interface ExecutionMetadata {
  instruction?: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  speed?: string;
  serviceTier?: string;
  agentSessionId?: string;
  onAgentEvent?: (event: AgentStreamEvent) => void;
  ui?: UiInteraction;
}

/** Host-owned interaction surface. Runtime code only asks semantically; it
 * never specifies visual components or modal presentation. */
export interface UiInteraction {
  choose(options: {
    label: string;
    options: readonly string[];
    multiple: boolean;
    allowCustom: boolean;
    customPlaceholder?: string;
  }): Promise<UiChoiceResult>;
  confirm(options: { message: string; confirmLabel: string; cancelLabel: string }): Promise<UiConfirmResult>;
  input(options: { label: string; placeholder?: string; multiline: boolean }): Promise<UiInputResult>;
}

export type AgentStreamPhase = "status" | "reasoning" | "message" | "tool";

export interface AgentStreamEvent {
  id?: string;
  phase: AgentStreamPhase;
  text: string;
  title?: string;
  replace?: boolean;
  done?: boolean;
  eventType?: string;
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
