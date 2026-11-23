declare module "dext" {
  /**
   * Import a result type when you annotate a return value: they are exported by this
   * module, not declared globally, so `export async function <leaf>(): Promise<AskResult>`
   * needs `import { ask, type AskResult } from "dext";`.
   * 
   * Values that cross a `dext` API boundary must be JSON-serializable. The kernel and the
   * extension host exchange JSON, so `Map`, `Set`, `Buffer`, functions and reference cycles
   * cannot be sent; a `Date` becomes an ISO string.
   */

  /** One applicable patch. No API returns one directly: this is the shape of
   * `AgentResult.patch`. */
  export interface PatchResult {
    kind: "patch";
    title: string;
    changes: PatchChange[];
  }

  /** Raw result of an MCP `tools/call` request. */
  export interface McpRawResult {
    kind: "mcpRaw";
    server: string;
    tool: string;
    content?: string;
    structured?: Record<string, unknown>;
    /** Cached MCP image blocks, each with a Webview-loadable URL. */
    images?: Array<{
      mimeType: string;
      url: string;
      byteLength?: number;
      width?: number;
      height?: number;
    }>;
    /** Why one or more image blocks were skipped; text and structured stay intact. */
    imageError?: string;
  }

  /** A workspace-relative directory reference. */
  export interface DirectoryReference {
    kind: "dir";
    path: string;
  }

  /** A resolved directory reference produced by the host. */
  export interface DirRef {
    kind: "dirRef";
    uri: string;
    path: string;
  }

  /** An inline editor reference accepted where a `context` value is expected. */
  export type ContextReference =
    | { kind: "selection" }
    | { kind: "activeFile" }
    | { kind: "file"; path: string }
    | { kind: "symbol"; name: string };

  /** Every value a Dext API can return. */
  export type DextResult = AskResult | PlanResult | AgentResult | TemplateResult | ApplyResult | TerminalResult | UiSelectResult | UiRadioResult | UiCheckboxResult | UiInputResult | UiConfirmResult | UiAlertResult | UiFormResult | SkillResult | McpRawResult;

  /** Codex per-call model selection options. */
  export interface AgentModelOptions {
    model: string;
    reasoning?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    speed?: "standard" | "fast";
  }

  /** Pi per-call model selection; reasoning levels come from the selected model. */
  export interface AgentPiModelOptions {
    model: string; // Pi provider/modelId.
    reasoning?: string;
  }

  /** Result of a continuous Agent task; preview-only edits may include a patch, while patch=false returns text only. */
  export interface AgentResult {
    kind: "agent";
    text: string;
    summary?: string;
    patch?: PatchResult;
    files?: CodeRef[];
  }

  /** Outcome of applying a patch. */
  export interface ApplyResult {
    kind: "apply";
    status: "applied" | "unchanged" | "conflict";
    summary: string;
    files: CodeRef[];
  }

  /** Text returned by Ask. */
  export interface AskResult {
    kind: "ask";
    text: string;
  }

  /** Reference to a code location and its captured content. */
  export interface CodeRef {
    kind: "codeRef";
    uri: string;
    range?: Range;
    symbol?: string;
    documentVersion: number;
    contentHash: string;
    content: string;
  }

  /** One document change in a patch. */
  export interface PatchChange {
    uri: string;
    before: string;
    after: string;
    range?: Range;
    documentVersion?: number;
    contentHash?: string;
  }

  /** Text returned by Plan and its optional saved-plan path; planPath is an absolute path under global storage and a plan-directory relative path under workspace storage. */
  export interface PlanResult {
    kind: "plan";
    text: string;
    planPath?: string;
    executePlan?: boolean;
    planOutcome?: Record<string, unknown>;
  }

  /** A zero-based position in a text document. */
  export interface Position {
    line: number;
    character: number;
  }

  /** A range in a text document. */
  export interface Range {
    start: Position;
    end: Position;
  }

  /** Text returned after executing a skill. */
  export interface SkillResult {
    kind: "skill";
    text: string;
  }

  /** Text rendered by Dext from a template; the model supplied only the field values. Nothing is written, so the caller saves it with fs.writeFile. */
  export interface TemplateResult {
    kind: "template";
    text: string;
  }

  /** Captured execution of a terminal command. */
  export interface TerminalResult {
    kind: "terminal";
    status: "succeeded" | "failed" | "timed_out";
    command: string;
    cwd: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    duration_ms: number;
  }

  /** A submit button. The pressed button's ID is returned as the result's `action`. */
  export interface UiAction {
    id: string;
    label: string;
    description?: string;
    primary?: boolean; // Highlighted button and the one Enter submits. Defaults to the first action.
    requires?: string[]; // Field IDs this action must have answered, even when the field itself is optional.
  }

  /** A static feedback message. */
  export interface UiAlert {
    type: "Alert";
    text: string;
    tone?: "normal" | "muted" | "info" | "warning" | "error"; // Defaults to "info".
  }

  /** Result returned by ui.alert. */
  export interface UiAlertResult {
    kind: "ui";
    type: "alert";
    status: "acknowledged" | "dismissed";
  }

  /** A visible label for a task or general feedback. */
  export interface UiBadge {
    type: "Badge";
    text: string;
    status?: "pending" | "in_progress" | "completed"; // Task status. Omitted by default.
    tone?: "normal" | "muted" | "info" | "warning" | "error"; // When omitted, the task status keeps its original appearance.
  }

  /** Result returned by ui.checkbox. */
  export interface UiCheckboxResult {
    kind: "ui";
    type: "checkbox";
    selected: string[];
    custom?: string;
  }

  /** Inline code with literal text. */
  export interface UiCode {
    type: "Code";
    text: string;
  }

  /** Preformatted code with literal text. Script output keeps its copy control disabled. */
  export interface UiCodeBlock {
    type: "CodeBlock";
    code: string;
  }

  /** Result returned by ui.confirm. */
  export interface UiConfirmResult {
    kind: "ui";
    type: "confirm";
    confirmed: boolean;
  }

  /** An explicitly empty state. */
  export interface UiEmpty {
    type: "Empty";
    text: string; // A non-empty visible message.
  }

  /** Base form field. The `type` discriminator selects a concrete field variant. */
  export interface UiField {
    id: string;
    type: "select" | "radio" | "checkbox" | "input";
    label: string;
    description?: string;
    required?: boolean;
    options?: (string | UiOption)[]; // Required for select, radio, and checkbox.
    default?: string | string[]; // A string for input, otherwise selected option values.
    multiple?: boolean; // Available only for select.
    allow_custom?: boolean; // Available only for radio and checkbox.
    custom_placeholder?: string; // Available only for radio and checkbox.
    placeholder?: string;
    multiline?: boolean; // Available only for input.
  }

  /** Answer for one form field. Selection fields expose selected; input fields expose value. Radio and checkbox fields may also expose custom. */
  export interface UiFieldAnswer {
    type: "select" | "radio" | "checkbox" | "input";
    selected?: string[];
    custom?: string;
    value?: string;
  }

  /** Result returned by ui.form. */
  export interface UiFormResult {
    kind: "ui";
    type: "form";
    status: "submitted" | "cancelled";
    action: string; // ID of the pressed action button, or an empty string when the form was cancelled.
    answers: Record<string, UiFieldAnswer>; // Answers keyed by form field ID. Index with a field ID to access its answer.
  }

  /** Spacing between layout children. */
  export type UiGap = "sm" | "md" | "lg";

  /** A horizontal sequence that wraps by default. */
  export interface UiInline {
    type: "Inline";
    gap?: UiGap; // Defaults to "sm".
    wrap?: boolean; // Defaults to true.
    children: UiLayoutChild[]; // Display children in declaration order. An empty array is allowed.
  }

  /** Result returned by ui.input. */
  export interface UiInputResult {
    kind: "ui";
    type: "input";
    value?: string;
  }

  /** A display node allowed inside a Stack, Inline or Section. */
  export type UiLayoutChild = UiStack | UiInline | UiSection | UiEmpty | UiTrace | UiText | UiMarkdown | UiCode | UiCodeBlock | UiSeparator | UiBadge | UiSpinner | UiAlert;

  /** Read-only Markdown with inert links, images and raw HTML. */
  export interface UiMarkdown {
    type: "Markdown";
    source: string;
  }

  /** A read-only display node accepted by ui.render. A tree accepts up to 32 levels, 1000 nodes and 262144 UTF-8 bytes. Validation reports the location of an invalid node, such as nodes[0].children[1]. */
  export type UiNode = UiTrace | UiTraceLine | UiTraceIcon | UiTraceTitle | UiTraceDescription | UiText | UiMarkdown | UiCode | UiCodeBlock | UiSeparator | UiBadge | UiSpinner | UiAlert | UiStack | UiInline | UiSection | UiEmpty;

  /** A labelled option accepted by a selection field. */
  export interface UiOption {
    value: string;
    label: string;
    description?: string;
  }

  /** Result returned by ui.radio. */
  export interface UiRadioResult {
    kind: "ui";
    type: "radio";
    selected: string[];
    custom?: string;
  }

  /** A titled section. The first section heading is h3 and nested sections increment to h6. */
  export interface UiSection {
    type: "Section";
    title: string; // A non-empty visible heading.
    description?: string; // Plain text below the heading. Omitted by default.
    children: UiLayoutChild[]; // Display children in declaration order. An empty array is allowed.
  }

  /** Result returned by ui.select. */
  export interface UiSelectResult {
    kind: "ui";
    type: "select";
    selected: string[];
  }

  /** A thematic break with no additional fields. */
  export interface UiSeparator {
    type: "Separator";
  }

  /** A read-only busy indicator. */
  export interface UiSpinner {
    type: "Spinner";
    label: string; // A non-empty visible name.
  }

  /** A vertical sequence of display nodes. */
  export interface UiStack {
    type: "Stack";
    gap?: UiGap; // Defaults to "md".
    children: UiLayoutChild[]; // Display children in declaration order. An empty array is allowed.
  }

  /** A plain-text node. */
  export interface UiText {
    type: "Text";
    text: string;
    tone?: "normal" | "muted" | "info" | "warning" | "error"; // Defaults to "normal".
  }

  /** A list of process rows. */
  export interface UiTrace {
    type: "Trace";
    ordered?: boolean; // Defaults to false.
    children: UiTraceLine[]; // Only TraceLine nodes are allowed directly inside a Trace.
  }

  /** A description for a process row. */
  export interface UiTraceDescription {
    type: "TraceDescription";
    text: string;
    tone?: "normal" | "muted" | "info" | "warning" | "error"; // Defaults to "normal".
  }

  /** A decorative icon for a process row. */
  export interface UiTraceIcon {
    type: "TraceIcon";
    icon: "check" | "terminal" | "diff" | "file-media" | "circle-small-filled" | "chevron-right" | "checklist" | "debug-pause" | "circle-large-outline" | "info" | "warning" | "error";
  }

  /** A process row. A standalone root row is supported for compatibility. */
  export interface UiTraceLine {
    type: "TraceLine";
    status?: "pending" | "in_progress" | "completed"; // Omitted by default.
    tone?: "normal" | "muted" | "info" | "warning" | "error"; // Defaults to "normal".
    children: UiTraceLineChild[];
  }

  /** A read-only node that can appear inside a trace line. */
  export type UiTraceLineChild = UiTrace | UiTraceIcon | UiTraceTitle | UiTraceDescription | UiText | UiMarkdown | UiCode | UiCodeBlock | UiSeparator | UiBadge | UiSpinner | UiAlert;

  /** The title of a process row. */
  export interface UiTraceTitle {
    type: "TraceTitle";
    text: string;
  }

  /** Ask — Hold a read-only conversation about a string input with optional inline Dext references. */
  export function ask(options: { input: string; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli?: undefined; model?: "sonnet" | "opus" | AgentModelOptions | AgentPiModelOptions } | { input: string; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "codex"; model?: AgentModelOptions } | { input: string; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "claude"; model?: "sonnet" | "opus" } | { input: string; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "deepseek-harness"; model?: { model: string; reasoning?: string } } | { input: string; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "pi"; model?: AgentPiModelOptions }): Promise<AskResult>;

  /** Plan — Generate and execute an implementation plan with the selected Plan write scope. */
  export function plan(options: { input: string; save?: boolean; location?: "global" | "workspace"; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli?: undefined; model?: "sonnet" | "opus" | AgentModelOptions | AgentPiModelOptions } | { input: string; save?: boolean; location?: "global" | "workspace"; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "codex"; model?: AgentModelOptions } | { input: string; save?: boolean; location?: "global" | "workspace"; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "claude"; model?: "sonnet" | "opus" } | { input: string; save?: boolean; location?: "global" | "workspace"; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "deepseek-harness"; model?: { model: string; reasoning?: string } } | { input: string; save?: boolean; location?: "global" | "workspace"; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "pi"; model?: AgentPiModelOptions }): Promise<PlanResult>;

  /** Agent — Run a continuous task from a string input with optional inline Dext references. By default, the selected Agent may modify a trusted workspace. */
  export function agent(options: { input: string; apply?: boolean; patch?: boolean; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli?: undefined; model?: "sonnet" | "opus" | AgentModelOptions | AgentPiModelOptions } | { input: string; apply?: boolean; patch?: boolean; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "codex"; model?: AgentModelOptions } | { input: string; apply?: boolean; patch?: boolean; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "claude"; model?: "sonnet" | "opus" } | { input: string; apply?: boolean; patch?: boolean; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "deepseek-harness"; model?: { model: string; reasoning?: string } } | { input: string; apply?: boolean; patch?: boolean; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "pi"; model?: AgentPiModelOptions }): Promise<AgentResult>;

  /** Render Template — Render text from a Dext template. The template declares the fields and the model only supplies their values, so the structure, section order and list markers always come from the template; the rendered output is validated as markdown, text, json, toml or yaml. Use it whenever an API emits a document — notes, reports, changelog entries, scaffolds — instead of concatenating text around an ask result. It returns text only and writes nothing: import Node's fs and write it yourself. */
  export function template(options: { input: string; source: string; values?: Record<string, unknown>; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli?: undefined; model?: "sonnet" | "opus" | AgentModelOptions | AgentPiModelOptions } | { input: string; source: string; values?: Record<string, unknown>; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "codex"; model?: AgentModelOptions } | { input: string; source: string; values?: Record<string, unknown>; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "claude"; model?: "sonnet" | "opus" } | { input: string; source: string; values?: Record<string, unknown>; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "deepseek-harness"; model?: { model: string; reasoning?: string } } | { input: string; source: string; values?: Record<string, unknown>; skills?: string | string[]; rules?: string | string[]; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "pi"; model?: AgentPiModelOptions }): Promise<TemplateResult>;

  /** Apply Patch — Apply the patch carried by an AgentResult. A valid AgentResult without a patch is allowed and returns unchanged; malformed patch payloads still throw. */
  export function apply(options: { result: DextResult }): Promise<ApplyResult>;

  /** Run Terminal Command — Run a command in a trusted local workspace and return captured output. The command runs without a confirmation prompt, so a workflow decides what is safe to run. */
  export function terminal(options: { command: string; cwd?: string; env?: Record<string, unknown>; timeout_ms?: number }): Promise<TerminalResult>;

  /** Interactive questions and read-only output for the current turn. */
  export const ui: {
    /** ui.select — Request select interaction and wait for the user's response. */
    select(options: { label: string; options: string[]; multiple?: boolean; placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiSelectResult>;
    /** ui.radio — Request radio interaction and wait for the user's response. */
    radio(options: { label: string; options: string[]; allow_custom?: boolean; custom_placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiRadioResult>;
    /** ui.checkbox — Request checkbox interaction and wait for the user's response. */
    checkbox(options: { label: string; options: string[]; allow_custom?: boolean; custom_placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiCheckboxResult>;
    /** ui.input — Request input interaction and wait for the user's response. */
    input(options: { label: string; placeholder?: string; multiline?: boolean; presentation?: "inline" | "dialog" }): Promise<UiInputResult>;
    /** ui.confirm — Request confirm interaction and wait for the user's response. */
    confirm(options: { message: string; confirm_label?: string; cancel_label?: string; on_cancel?: "return" | "abort"; presentation?: "inline" | "dialog" }): Promise<UiConfirmResult>;
    /** ui.alert — Request alert interaction and wait for the user's response. */
    alert(options: { message: string; acknowledge_label?: string; presentation?: "inline" | "dialog" }): Promise<UiAlertResult>;
    /** ui.form — Request form interaction and wait for the user's response. */
    form(options: { title: string; fields: UiField[]; description?: string; submit_label?: string; cancel_label?: string; show_cancel?: boolean; actions?: UiAction[]; on_cancel?: "return" | "abort"; presentation?: "inline" | "dialog" }): Promise<UiFormResult>;
    /** ui.render — Append an ordered, read-only tree of display components to this turn's Output. The call completes after Dext records it. */
    render(options: { nodes: UiNode[] }): Promise<void>;
  };

  /** Run Skill — Load and execute a standard SKILL.md from the configured project skill directories. Skill calls are read-only by default. */
  export function skill(options: { skill: string; input: string; apply?: boolean; workspace?: DirectoryReference | DirRef; echo?: boolean; cli?: undefined; model?: "sonnet" | "opus" | AgentModelOptions | AgentPiModelOptions } | { skill: string; input: string; apply?: boolean; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "codex"; model?: AgentModelOptions } | { skill: string; input: string; apply?: boolean; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "claude"; model?: "sonnet" | "opus" } | { skill: string; input: string; apply?: boolean; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "deepseek-harness"; model?: { model: string; reasoning?: string } } | { skill: string; input: string; apply?: boolean; workspace?: DirectoryReference | DirRef; echo?: boolean; cli: "pi"; model?: AgentPiModelOptions }): Promise<SkillResult>;

  /**
   * `mcp.<server>.<tool>` — call a configured MCP tool. Servers and tools are
   * configured per project, so the proxy is declared by index signature.
   */
  export const mcp: { [server: string]: { [tool: string]: (options?: Record<string, unknown>) => Promise<McpRawResult> } };
}
