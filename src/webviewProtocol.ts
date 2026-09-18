import type { ResourceSession } from "./resourceSession.js";
import { uiFormResultSchema } from "./core/uiForm.js";
import { z } from "zod";
import type {
  CompletionItem,
  LanguageHover,
  LanguageDiagnostic,
  SignatureHelp
} from "./core/languageService.js";
import type { AgentStreamEvent, InputExecutionResponse, RegisteredCallable, PlanExecutionOutcome } from "./core/types.js";
import type { TurnReview } from "./core/turnReview.js";
import type { KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";
import type { PlanReview } from "./core/planReview.js";
import type { ReviewPreset } from "./core/projectContext.js";
import type { AgentProfile, AgentSelection } from "./agentProfiles.js";
import type { EditorTokenTheme } from "./vscodeTheme.js";
import type { DextHistorySession, PlanStatus } from "./historyStore.js";
import type { McpDiscoveredTool, McpServerConfig } from "./core/mcpRegistry.js";

/** HTTP MCP credentials are never written to a manifest: bearer uses the
 * SecretStorage token in an Authorization header, query attaches it to the
 * request URL under the declared parameter name. */
const mcpHttpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }).strict(),
  z.object({
    type: z.literal("query"),
    name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/)
  }).strict()
]);

export const webviewRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("inputDefinition"), requestId: z.number().int().nonnegative(), source: z.string(), cursor: z.number().int().nonnegative() }),
  z.object({ type: z.literal("openInputDefinition"), source: z.string(), cursor: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("language"),
    requestId: z.number().int().nonnegative(),
    source: z.string(),
    cursor: z.number().int().nonnegative(),
    purpose: z.enum(["all", "completion", "diagnostics", "inputKind", "signature", "hover"]).optional()
  }),
  z.object({
    type: z.literal("executeInput"),
    mode: z.enum(["agent", "ask", "plan", "code"]),
    source: z.string().min(1),
    planPath: z.string().min(1).max(512).optional()
  }),
  z.object({ type: z.literal("stopExecution"), turnId: z.string().min(1) }),
  z.object({
    type: z.literal("agentInputResponse"),
    sessionId: z.string().min(1), turnId: z.string().min(1), requestId: z.string().min(1),
    answers: z.record(z.string().min(1).max(256), z.object({
      answers: z.array(z.string().min(1).max(20000)).length(1)
    })).nullable()
  }),
  z.object({ type: z.literal("retryTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("forkFromTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("renameTurn"), sessionId: z.string().min(1), turnId: z.string().min(1) }),
  z.object({ type: z.literal("deleteTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("copyTurn"), turnId: z.string().min(1), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal("reviewDecision"),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    runId: z.string().min(1),
    decision: z.enum(["accepted", "rejected"])
  }),
  z.object({
    type: z.literal("planReviewDecision"),
    sessionId: z.string().min(1),
    /** The review is bound to a plan version and a Build run, so a decision cannot land on a later Build. */
    planVersion: z.string().min(1),
    runId: z.string().min(1),
    decision: z.enum(["accepted", "rejected"])
  }),
  z.object({
    type: z.literal("adoptKnowledgeSuggestion"),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    suggestionId: z.string().min(1)
  }),
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
  z.object({ type: z.literal("openBuiltinApiDefinition"), id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/) }),
  z.object({ type: z.literal("openExternalLink"), url: z.string().min(1) }),
  z.object({
    type: z.literal("searchFiles"),
    requestId: z.number().int().nonnegative(),
    query: z.string().max(120)
  }),
  z.object({ type: z.literal("chooseFiles") }),
  z.object({ type: z.literal("searchProjectReferences"), requestId: z.string().min(1), query: z.string().max(200) }),
  z.object({ type: z.literal("openProjectReference"), objectId: z.string().min(1).max(256) }),
  z.object({
    type: z.literal("resolveDroppedFiles"),
    requestId: z.number().int().nonnegative(),
    paths: z.array(z.string().min(1).max(8192).regex(/^[^\r\n]+$/)).min(1).max(100)
  }),
  z.object({
    type: z.literal("pasteImage"),
    data: z.string().min(1),
    mimeType: z.string().min(1)
  }),
  z.object({ type: z.literal("deleteImageAttachment"), relativePath: z.string().min(1) }),
  z.object({
    type: z.literal("uiResponse"),
    sessionId: z.string().min(1).max(128), turnId: z.string().min(1).max(128), requestId: z.string().min(1).max(128),
    response: uiFormResultSchema
  }).strict(),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("addMcp") }),
  z.object({ type: z.literal("openResourceCreator") }),
  z.object({ type: z.literal("resourceOptions"), sessionId: z.string().min(1), resourceType: z.enum(["api", "mcp", "rule", "skill"]), scope: z.enum(["project", "global"]) }),
  z.object({ type: z.literal("chooseResource"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("previewResource"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("saveResource"), sessionId: z.string().min(1) }),
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
        url: z.string().min(1).max(2048), auth: mcpHttpAuthSchema.optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional()
      }).strict()
    ])
  }),
  z.object({
    type: z.literal("prepareMcp"), requestId: z.string().min(1), scope: z.enum(["project", "global"]).optional(),
    server: z.discriminatedUnion("transport", [
      z.object({ name: z.string().min(1).max(80), transport: z.literal("stdio"), command: z.string().min(1).max(512), args: z.array(z.string().max(512)).max(32).optional(), auth: z.object({ type: z.literal("token"), env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict(),
      z.object({ name: z.string().min(1).max(80), transport: z.literal("http"), url: z.string().min(1).max(2048), auth: mcpHttpAuthSchema.optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict()
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
  resourceRoots?: { project?: string; global: string };
}

export type WebviewResponse =
  | { type: "inputDefinition"; requestId: number; target?: InputDefinition }
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
    resource?: ResourceSession;
    switchId?: number;
    hostInitiated?: true;
  }
  | { type: "planContext"; path?: string; status: PlanStatus }
  | { type: "resourceContext"; sessionId: string; resource: ResourceSession; busy?: boolean }
  | {
    type: "conversations";
    sessions: ConversationSummary[];
    activeId: string;
    /** Active conversation-scoped controls, sent with the tab update so a
     * tab switch does not need to resend the full sidebar state. */
    selection?: AgentSelection;
    planPath?: string;
    planStatus?: PlanStatus;
    resource?: ResourceSession;
    switchId?: number;
    hostInitiated?: true;
  }
  | { type: "mcpAssistant" }
  | { type: "mcpProgress"; requestId: string; event: AgentStreamEvent }
  | { type: "mcpToolsDiscovered"; requestId: string; tools: McpDiscoveredTool[] }
  | { type: "mcpGenerated"; requestId: string; server: McpServerConfig }
  | { type: "mcpCreated"; name: string }
  /** `reviewPatch` is set when the host is holding an unapplied patch for this
   * turn, which is what puts Accept and Reject on its file changes. */
  | { type: "execution"; sessionId: string; turnId: string; response: InputExecutionResponse; reviewPatch?: boolean }
  /** Per-run Review attachment. It is conversation-scoped, never project knowledge. */
  | {
    type: "turnReview";
    sessionId: string;
    turnId: string;
    review: TurnReview;
    preset?: ReviewPreset;
    /** Unaccepted drafts. Adopting one writes a project object; accepting the code writes nothing. */
    knowledgeSuggestions?: KnowledgeSuggestion[];
  }
  | {
    type: "knowledgeSuggestionDecision";
    sessionId: string;
    turnId: string;
    suggestionId: string;
    status: "adopted" | "stale" | "not_applicable";
    objectId?: string;
  }
  | {
    type: "turnReviewDecision";
    sessionId: string;
    turnId: string;
    runId: string;
    status: "accepted" | "rejected" | "stale";
  }
  /** One Build review, accumulating every executed round for the same plan version. */
  | { type: "planReview"; sessionId: string; review: PlanReview }
  | {
    type: "planReviewDecision";
    sessionId: string;
    planVersion: string;
    runId: string;
    status: "accepted" | "rejected";
  }
  | { type: "executionFailed"; sessionId: string; turnId: string; message: string; planOutcome?: PlanExecutionOutcome }
  | {
    type: "patchResolved";
    sessionId: string;
    turnId: string;
    uris: string[];
    status: "applied" | "rejected" | "conflict" | "unchanged";
    message: string;
  }
  | { type: "agentEvent"; sessionId: string; event: AgentStreamEvent }
  | { type: "focusAgentInput"; sessionId: string; turnId: string; requestId: string; kind: "agent" | "ui" }
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
  | { type: "projectReferenceSearchResult"; requestId: string; items: Array<{ objectId: string; canonicalName: string; displayName?: string; aliases: string[]; kind: string; token: string }>; error?: string }
  | { type: "resolveDroppedFilesResult"; requestId: number; expressions: string[]; error?: string }
  | { type: "setInput"; source: string }
  | { type: "focusInput" }
  | { type: "triggerSuggest" }
  | { type: "triggerParameterHints" }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "focusEditor" };

export interface InputDefinition {
  uri: string;
  content?: string;
  originFrom: number;
  originTo: number;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}
