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
import type { DextHistorySession } from "./historyStore.js";

export const webviewRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("language"),
    requestId: z.number().int().nonnegative(),
    source: z.string(),
    cursor: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("executeInput"),
    mode: z.enum(["agent", "ask", "code"]),
    source: z.string().min(1)
  }),
  z.object({ type: z.literal("stopExecution"), turnId: z.string().min(1) }),
  z.object({
    type: z.literal("clipboardWrite"),
    requestId: z.number().int().nonnegative(),
    text: z.string()
  }),
  z.object({
    type: z.literal("clipboardRead"),
    requestId: z.number().int().nonnegative(),
    purpose: z.literal("code")
  }),
  z.object({ type: z.literal("openFileReference"), reference: z.string().min(1) }),
  z.object({
    type: z.literal("dropFiles"),
    items: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("uri"), value: z.string().min(1) }),
      z.object({ kind: z.literal("path"), value: z.string().min(1) })
    ])).max(8),
    position: z.number().int().nonnegative().optional()
  }),
  z.object({ type: z.literal("chooseFiles") }),
  z.object({
    type: z.literal("pasteImage"),
    data: z.string().min(1),
    mimeType: z.string().min(1)
  }),
  z.object({ type: z.literal("deleteImageAttachment"), relativePath: z.string().min(1) }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("debugLog"), message: z.string() }),
  z.object({ type: z.literal("viewHistory") }),
  z.object({ type: z.literal("newConversation") }),
  z.object({ type: z.literal("selectConversation"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("clearOutput") }),
  z.object({
    type: z.literal("agentSelection"),
    selection: z.object({
      mode: z.enum(["agent", "ask", "code"]),
      profileId: z.string(),
      model: z.string(),
      reasoningEffort: z.string(),
      speed: z.string(),
      serviceTier: z.string()
    }).strict()
  })
]);

export type WebviewRequest = z.infer<typeof webviewRequestSchema>;

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  turnCount: number;
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
  | { type: "outputSession"; session: DextHistorySession }
  | { type: "conversations"; sessions: ConversationSummary[]; activeId: string }
  | { type: "execution"; turnId: string; response: InputExecutionResponse }
  | { type: "executionFailed"; turnId: string; message: string }
  | { type: "agentEvent"; event: AgentStreamEvent }
  | { type: "executing"; value: boolean; turnId: string; source?: string }
  | { type: "inputKind"; kind: "empty" | "workflow" | "invalid" }
  | { type: "insertFileReferences"; expressions: string[]; position?: number }
  | { type: "imageAttachment"; relativePath: string; webviewUri: string; name: string }
  | { type: "clipboardWriteResult"; requestId: number; success: boolean }
  | {
    type: "clipboardReadResult";
    requestId: number;
    success: boolean;
    text: string;
    contextAttached: boolean;
    codeReference?: { expression: string; payload: string };
  }
  | { type: "focusInput" }
  | { type: "triggerSuggest" }
  | { type: "triggerParameterHints" }
  | { type: "error"; message: string }
  | { type: "focusEditor" };
