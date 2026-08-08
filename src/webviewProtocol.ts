import { z } from "zod";
import type {
  CompletionItem,
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
  z.object({ type: z.literal("executeChat"), message: z.string() }),
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
    }
  | { type: "execution"; response: RuntimeResponse }
  | { type: "executing"; value: boolean }
  | { type: "error"; message: string }
  | { type: "focusEditor" };
