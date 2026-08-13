import { z } from "zod";
import type {
  CompletionItem,
  LanguageHover,
  LanguageDiagnostic,
  SignatureHelp
} from "./core/languageService.js";
import type { InputExecutionResponse, RegisteredCallable } from "./core/types.js";
import type { EditorTokenTheme } from "./vscodeTheme.js";

export const webviewRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("language"),
    requestId: z.number().int().nonnegative(),
    source: z.string(),
    cursor: z.number().int().nonnegative()
  }),
  z.object({ type: z.literal("executeInput"), source: z.string().min(1) }),
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
    ])).max(8)
  }),
  z.object({ type: z.literal("chooseFiles") }),
  z.object({ type: z.literal("reload") })
]);

export type WebviewRequest = z.infer<typeof webviewRequestSchema>;

export interface SidebarState {
  trusted: boolean;
  theme?: EditorTokenTheme;
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
      inputKind: "empty" | "workflow" | "invalid";
      signature?: SignatureHelp;
      hover?: LanguageHover;
    }
  | { type: "execution"; response: InputExecutionResponse }
  | { type: "executing"; value: boolean }
  | { type: "inputKind"; kind: "empty" | "workflow" | "invalid" }
  | { type: "insertFileReferences"; expressions: string[] }
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
