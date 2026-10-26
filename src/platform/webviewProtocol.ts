import { z } from "zod";
import type { McpDiscoveredTool, McpServerConfig } from "../features/mcp/contracts/mcp.js";
import type { AgentStreamEvent, RegisteredCallable } from "../shared/contracts/types.js";
import type { AgentProfile, AgentSelection } from "../features/agents/contracts/agent.js";
import type { SkillCommandSummary, SkillSummary } from "../features/workflow/contracts/skill.js";
import {
  conversationRequestSchemas,
  type ConversationSummary as ConversationSummaryContract,
  type ConversationWebviewResponse
} from "../features/conversations/contracts/protocol.js";
import { fileSearchRequestSchema, type FileSearchResponse } from "../features/workspace/contracts/fileSearch.js";
import type { EditorTokenTheme } from "./vscode/theme.js";

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

export type ConversationSummary = ConversationSummaryContract;

/** The host's whole request union. Conversation, workspace and resource messages
 * keep their schema in the feature that owns them; this list only composes
 * them, so a new conversation action does not edit every other feature. */
export const webviewRequestSchema = z.discriminatedUnion("type", [
  ...conversationRequestSchemas,
  z.object({ type: z.literal("ready") }),
  // The composer asks for its types rather than only waiting for the host to push
  // them: a Webview that missed the first message still gets its declaration, its
  // API modules and its completion, instead of a silently dumb editor.
  z.object({ type: z.literal("composerTypes") }),
  // …and reports what it applied, so **Dext Input** shows both halves of the exchange.
  z.object({
    type: z.literal("composerTypesApplied"),
    builtins: z.number().int().min(0).max(10000),
    modules: z.number().int().min(0).max(10000)
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
  fileSearchRequestSchema,
  z.object({ type: z.literal("chooseFiles") }),
  z.object({ type: z.literal("searchProjectReferences"), requestId: z.string().min(1), query: z.string().max(200) }),
  z.object({ type: z.literal("openProjectReference"), objectId: z.string().min(1).max(256) }),
  z.object({
    type: z.literal("resolveDroppedFiles"),
    requestId: z.number().int().nonnegative(),
    paths: z.array(z.string().min(1).max(8192).regex(/^[^\r\n]+$/)).min(1).max(100)
  }),
  z.object({
    type: z.literal("selectDroppedFile"),
    target: z.enum(["plan", "resource"]),
    sessionId: z.string().min(1).optional(),
    path: z.string().min(1).max(8192).regex(/^[^\r\n]+$/)
  }),
  z.object({
    type: z.literal("pasteImage"),
    data: z.string().min(1),
    mimeType: z.string().min(1)
  }),
  z.object({ type: z.literal("deleteImageAttachment"), relativePath: z.string().min(1) }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("addMcp") }),
  z.object({ type: z.literal("openResourceCreator") }),
  z.object({ type: z.literal("resourceOptions"), sessionId: z.string().min(1), resourceType: z.enum(["api", "mcp", "rule", "skill", "file"]), scope: z.enum(["project", "global"]) }),
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
  })
]);

export type WebviewRequest = z.infer<typeof webviewRequestSchema>;

export interface SidebarState {
  theme?: EditorTokenTheme;
  methods: Pick<
    RegisteredCallable,
    "id" | "title" | "description" | "kind" | "source" | "input" | "output"
  >[];
  diagnostics: string[];
  agentProfiles: AgentProfile[];
  agentSelection: AgentSelection;
  /** Installed skills, grouped by pack id. Source paths stay host-side. */
  skills?: SkillSummary[];
  /** Commands whose skill can be selected in the composer. */
  skillCommands?: SkillCommandSummary[];
  /** Skills are disabled outside a trusted local workspace. */
  skillsEnabled?: boolean;
  skillsDisabledReason?: string;
  settings?: {
    diffView: "inline" | "split";
    submitOnEnter: boolean;
  };
  mcpServers: McpServerConfig[];
  globalDiagnostics: string[];
  resourceRoots?: { project?: string; global: string };
}

export type WebviewResponse =
  | ConversationWebviewResponse
  | { type: "state"; state: SidebarState }
  /** The generated `dext` declaration, so Monaco's TypeScript worker completes
   * and diagnoses `import { ask } from "dext"` in the composer — plus the workspace's
   * own API modules, because Monaco has no filesystem and cannot read `.dext/api`.
   * `apiPaths` is the generated project's `dext/api/*` mapping, `path` is where each
   * module lives under the virtual `.dext` root the mapping resolves against, and
   * `specifier` is the `dext/api/<id>` the module answers to. */
  | {
    type: "dextTypes";
    declaration: string;
    apiPaths: string[];
    modules: { path: string; specifier: string; content: string }[];
  }
  | { type: "mcpAssistant" }
  | { type: "mcpProgress"; requestId: string; event: AgentStreamEvent }
  | { type: "mcpToolsDiscovered"; requestId: string; tools: McpDiscoveredTool[] }
  | { type: "mcpGenerated"; requestId: string; server: McpServerConfig }
  | { type: "mcpCreated"; name: string }
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
  | FileSearchResponse
  | { type: "projectReferenceSearchResult"; requestId: string; items: Array<{ objectId: string; canonicalName: string; displayName?: string; aliases: string[]; kind: string; token: string }>; error?: string }
  | { type: "resolveDroppedFilesResult"; requestId: number; expressions: string[]; error?: string }
  | { type: "setInput"; source: string }
  | { type: "focusInput" }
  | { type: "triggerSuggest" }
  | { type: "triggerParameterHints" }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "focusEditor" };
