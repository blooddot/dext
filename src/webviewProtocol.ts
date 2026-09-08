import { z } from "zod";
import type {
  CompletionItem,
  LanguageHover,
  LanguageDiagnostic,
  SignatureHelp
} from "./core/languageService.js";
import type { AgentStreamEvent, InputExecutionResponse, RegisteredCallable } from "./core/types.js";
import type { AgentProfile, AgentSelection } from "./agentProfiles.js";
import type { EditorTokenTheme } from "./vscodeTheme.js";
import type { DextHistorySession, PlanStatus } from "./historyStore.js";
import type { McpDiscoveredTool, McpServerConfig } from "./core/mcpRegistry.js";

export const webviewRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("language"),
    requestId: z.number().int().nonnegative(),
    source: z.string(),
    cursor: z.number().int().nonnegative(),
    purpose: z.enum(["all", "completion", "diagnostics", "inputKind", "signature"]).optional()
  }),
  z.object({
    type: z.literal("executeInput"),
    mode: z.enum(["agent", "ask", "plan", "code"]),
    source: z.string().min(1),
    planPath: z.string().min(1).max(512).optional()
  }),
  z.object({ type: z.literal("stopExecution"), turnId: z.string().min(1) }),
  z.object({ type: z.literal("retryTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("forkFromTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("renameTurn"), sessionId: z.string().min(1), turnId: z.string().min(1) }),
  z.object({ type: z.literal("deleteTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("copyTurn"), turnId: z.string().min(1), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("buildPlan"), planPath: z.string().min(1).max(512) }),
  z.object({ type: z.literal("choosePlan") }),
  z.object({
    type: z.literal("resolvePatch"),
    turnId: z.string().min(1),
    /** Empty means every file the turn proposed, which is the Accept all path. */
    uris: z.array(z.string().min(1)).max(200),
    accept: z.boolean()
  }),
  z.object({
    type: z.literal("clipboardWrite"),
    requestId: z.number().int().nonnegative(),
    text: z.string()
  }),
  z.object({
    type: z.literal("clipboardRead"),
    requestId: z.number().int().nonnegative(),
    purpose: z.enum(["code", "text"])
  }),
  z.object({ type: z.literal("openFileReference"), reference: z.string().min(1) }),
  z.object({ type: z.literal("openExternalLink"), url: z.string().min(1) }),
  z.object({
    type: z.literal("searchFiles"),
    requestId: z.number().int().nonnegative(),
    query: z.string().max(120)
  }),
  z.object({ type: z.literal("chooseFiles") }),
  z.object({
    type: z.literal("pasteImage"),
    data: z.string().min(1),
    mimeType: z.string().min(1)
  }),
  z.object({ type: z.literal("deleteImageAttachment"), relativePath: z.string().min(1) }),
  z.object({
    type: z.literal("uiResponse"),
    requestId: z.string().min(1),
    response: z.discriminatedUnion("type", [
      z.object({ type: z.literal("choice"), selected: z.array(z.string()), custom: z.string().optional() }),
      z.object({ type: z.literal("confirm"), confirmed: z.boolean() }),
      z.object({ type: z.literal("input"), value: z.string().optional() })
    ])
  }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("openMcp") }),
  z.object({ type: z.literal("addMcp") }),
  z.object({ type: z.literal("generateMcp"), requestId: z.string().min(1), document: z.string().min(1).max(80000) }),
  z.object({
    type: z.literal("createMcp"),
    scope: z.enum(["project", "global"]).optional(),
    selectedTools: z.array(z.string().min(1).max(200)).max(1000).optional(),
    server: z.discriminatedUnion("transport", [
      z.object({
        name: z.string().min(1).max(80), transport: z.literal("stdio"),
        command: z.string().min(1).max(512), args: z.array(z.string().max(512)).max(32).optional(),
        auth: z.object({ type: z.literal("token"), env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional()
      }).strict(),
      z.object({
        name: z.string().min(1).max(80), transport: z.literal("http"),
        url: z.string().min(1).max(2048), auth: z.object({ type: z.literal("bearer") }).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional()
      }).strict()
    ])
  }),
  z.object({
    type: z.literal("prepareMcp"), requestId: z.string().min(1), scope: z.enum(["project", "global"]).optional(),
    server: z.discriminatedUnion("transport", [
      z.object({ name: z.string().min(1).max(80), transport: z.literal("stdio"), command: z.string().min(1).max(512), args: z.array(z.string().max(512)).max(32).optional(), auth: z.object({ type: z.literal("token"), env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict(),
      z.object({ name: z.string().min(1).max(80), transport: z.literal("http"), url: z.string().min(1).max(2048), auth: z.object({ type: z.literal("bearer") }).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict()
    ])
  }),
  z.object({ type: z.literal("newConversation") }),
  z.object({ type: z.literal("selectConversation"), sessionId: z.string().min(1), switchId: z.number().int().positive().optional() }),
  z.object({ type: z.literal("outputSessionRefMiss"), sessionId: z.string().min(1), signature: z.string(), switchId: z.number().int().positive().optional(), hostInitiated: z.literal(true).optional() }),
  z.object({ type: z.literal("closeConversation"), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal("moveConversation"),
    sessionId: z.string().min(1),
    beforeSessionId: z.string().min(1).nullable()
  }),
  z.object({
    type: z.literal("pinConversation"),
    sessionId: z.string().min(1),
    pinned: z.boolean()
  }),
  z.object({
    type: z.literal("agentSelection"),
    selection: z.object({
      mode: z.enum(["agent", "ask", "plan", "code"]),
      permission: z.enum(["workspace-write", "full-access"]),
      profileId: z.string(),
      agentPreset: z.string().max(128).optional(),
      model: z.string(),
      reasoningEffort: z.string(),
      speed: z.string(),
      serviceTier: z.string()
    }).strict()
  }),
  z.object({ type: z.literal("harnessPresetAction"), action: z.enum(["create", "copy", "edit", "refresh"]) })
]);

export type WebviewRequest = z.infer<typeof webviewRequestSchema>;

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  turnCount: number;
  pinned: boolean;
  running: boolean;
}

export interface GlobalResourceItem {
  name: string;
  detail?: string;
}

export interface GlobalResources {
  apis: GlobalResourceItem[];
  mcps: GlobalResourceItem[];
  rules: GlobalResourceItem[];
  skills: GlobalResourceItem[];
}

export interface SidebarState {
  theme?: EditorTokenTheme;
  methods: Pick<
    RegisteredCallable,
    "id" | "title" | "description" | "kind" | "source" | "input" | "output"
  >[];
  diagnostics: string[];
  agentProfiles: AgentProfile[];
  agentSelection: AgentSelection;
  settings?: {
    diffView: "inline" | "split";
    submitOnEnter: boolean;
  };
  mcpServers: McpServerConfig[];
  globalDiagnostics: string[];
  globalResources?: GlobalResources;
}

export type WebviewResponse =
  | { type: "state"; state: SidebarState }
  | {
    type: "language";
    requestId: number;
    completions: CompletionItem[];
    diagnostics: LanguageDiagnostic[];
    inputKind: "empty" | "workflow" | "invalid";
    signature?: SignatureHelp;
    hover?: LanguageHover;
  }
  | { type: "outputSession"; session: DextHistorySession; switchId?: number; hostInitiated?: true }
  | { type: "turnRenamed"; sessionId: string; turnId: string; title?: string; displayTitle: string }
  | { type: "outputSessionRef"; sessionId: string; signature: string; switchId?: number; hostInitiated?: true }
  | {
    type: "activeConversation";
    activeId: string;
    selection: AgentSelection;
    planPath?: string;
    planStatus: PlanStatus;
    switchId?: number;
    hostInitiated?: true;
  }
  | { type: "planContext"; path?: string; status: PlanStatus }
  | {
    type: "conversations";
    sessions: ConversationSummary[];
    activeId: string;
    /** Active conversation-scoped controls, sent with the tab update so a
     * tab switch does not need to resend the full sidebar state. */
    selection?: AgentSelection;
    planPath?: string;
    planStatus?: PlanStatus;
    switchId?: number;
    hostInitiated?: true;
  }
  | { type: "openMethods" }
  | { type: "openMcp" }
  | { type: "mcpAssistant" }
  | { type: "mcpProgress"; requestId: string; event: AgentStreamEvent }
  | { type: "mcpToolsDiscovered"; requestId: string; tools: McpDiscoveredTool[] }
  | { type: "mcpGenerated"; requestId: string; server: McpServerConfig }
  | { type: "mcpCreated"; name: string }
  | {
    type: "uiRequest";
    requestId: string;
    request: {
      type: "choice";
      label: string;
      options: string[];
      multiple: boolean;
      allowCustom: boolean;
      customPlaceholder?: string;
    } | { type: "confirm"; message: string; confirmLabel: string; cancelLabel: string }
      | { type: "input"; label: string; placeholder?: string; multiline: boolean };
  }
  /** `reviewPatch` is set when the host is holding an unapplied patch for this
   * turn, which is what puts Accept and Reject on its file changes. */
  | { type: "execution"; sessionId: string; turnId: string; response: InputExecutionResponse; reviewPatch?: boolean }
  | { type: "executionFailed"; sessionId: string; turnId: string; message: string }
  | {
    type: "patchResolved";
    sessionId: string;
    turnId: string;
    uris: string[];
    status: "applied" | "rejected" | "conflict" | "unchanged";
    message: string;
  }
  | { type: "agentEvent"; sessionId: string; event: AgentStreamEvent }
  | { type: "agentEvents"; sessionId: string; events: AgentStreamEvent[]; switchId?: number }
  | { type: "executing"; sessionId: string; value: boolean; turnId: string; source?: string; mode?: "agent" | "ask" | "plan" | "code"; planPath?: string; executePlan?: boolean; startedAt?: number; switchId?: number; hostInitiated?: true }
  | { type: "inputKind"; kind: "empty" | "workflow" | "invalid" }
  | { type: "insertFileReferences"; expressions: string[] }
  | { type: "imageAttachment"; relativePath: string; webviewUri: string; name: string }
  | { type: "clipboardWriteResult"; requestId: number; success: boolean }
  | {
    type: "clipboardReadResult";
    requestId: number;
    success: boolean;
    text: string;
    contextAttached: boolean;
    codeReference?: { expression: string; payload: string };
    fileReferences?: Array<{ expression: string; payload: string }>;
  }
  | { type: "searchFilesResult"; requestId: number; files: string[] }
  | { type: "setInput"; source: string }
  | { type: "focusInput" }
  | { type: "triggerSuggest" }
  | { type: "triggerParameterHints" }
  | { type: "error"; message: string }
  | { type: "focusEditor" };
