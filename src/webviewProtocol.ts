import { z } from "zod";
import type { AttachmentView } from "./attachmentStore.js";
import type {
  CompletionItem,
  LanguageHover,
  LanguageDiagnostic,
  SignatureHelp
} from "./core/languageService.js";
import type { RegisteredCallable, RuntimeResponse } from "./core/types.js";

export const webviewRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("language"),
    requestId: z.number().int().nonnegative(),
    source: z.string(),
    cursor: z.number().int().nonnegative()
  }),
  z.object({ type: z.literal("executeCode"), source: z.string() }),
  z.object({
    type: z.literal("executeChat"),
    message: z.string(),
    attachmentIds: z.array(z.string().min(1)).max(8)
  }),
  z.object({
    type: z.literal("clipboardWrite"),
    requestId: z.number().int().nonnegative(),
    text: z.string()
  }),
  z.object({
    type: z.literal("clipboardRead"),
    requestId: z.number().int().nonnegative(),
    purpose: z.enum(["code", "chat"])
  }),
  z.object({ type: z.literal("removeAttachment"), attachmentId: z.string().min(1) }),
  z.object({ type: z.literal("openAttachment"), attachmentId: z.string().min(1) }),
  z.object({ type: z.literal("openFileReference"), reference: z.string().min(1) }),
  z.object({
    type: z.literal("dropFiles"),
    items: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("uri"), value: z.string().min(1) }),
      z.object({ kind: z.literal("path"), value: z.string().min(1) })
    ])).max(8)
  }),
  z.object({ type: z.literal("chooseFiles") }),
  z.object({ type: z.literal("reload") })
]);

export type WebviewRequest = z.infer<typeof webviewRequestSchema>;

export interface SidebarState {
  trusted: boolean;
  methods: Pick<
    RegisteredCallable,
    "id" | "title" | "description" | "kind" | "source" | "input" | "output"
  >[];
  diagnostics: string[];
}

export type WebviewResponse =
  | { type: "state"; state: SidebarState }
  | {
      type: "language";
      requestId: number;
      completions: CompletionItem[];
      diagnostics: LanguageDiagnostic[];
      signature?: SignatureHelp;
      hover?: LanguageHover;
    }
  | { type: "execution"; response: RuntimeResponse }
  | { type: "executing"; value: boolean }
  | { type: "attachments"; attachments: AttachmentView[] }
  | { type: "clipboardWriteResult"; requestId: number; success: boolean }
  | {
      type: "clipboardReadResult";
      requestId: number;
      success: boolean;
      text: string;
      contextAttached: boolean;
      codeReference?: { expression: string; payload: string };
    }
  | { type: "showChat" }
  | { type: "triggerSuggest" }
  | { type: "triggerParameterHints" }
  | { type: "error"; message: string }
  | { type: "focusEditor" };
