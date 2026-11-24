export const OUTPUT_LANGUAGES = ["auto", "zh-CN", "zh-TW", "en", "ja", "ko"] as const;

export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];
export type ResolvedOutputLanguage = Exclude<OutputLanguage, "auto">;

export interface NativeConversationBaseline {
  version: number;
  outputLanguage: ResolvedOutputLanguage | null;
}

export interface ProviderInstructionBaseline extends NativeConversationBaseline {
  sessionId: string;
}
