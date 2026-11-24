import { OUTPUT_LANGUAGES, type OutputLanguage, type ResolvedOutputLanguage } from "../../../shared/contracts/conversationInstructions.js";
export { OUTPUT_LANGUAGES, type OutputLanguage, type ResolvedOutputLanguage };

const LANGUAGE_NAMES: Record<ResolvedOutputLanguage, string> = {
  "zh-CN": "Simplified Chinese (zh-CN)",
  "zh-TW": "Traditional Chinese (zh-TW)",
  en: "English (en)",
  ja: "Japanese (ja)",
  ko: "Korean (ko)"
};

const EXPLICIT_LANGUAGE_PRIORITY = "If the user explicitly asks for another language or a translation in this turn, follow that request instead.";
const FORMAT_PROTECTION = [
  "- Keep the structure and protocol intact: do not translate section headings required by the Plan format, task checklist numbering or status markers, code, commands, file paths, identifiers, quoted source text, or Dext delimiter lines.",
  "- Never translate machine-readable output: JSON keys, schema field names, enum values, type names, and any value the response contract defines. Only human-readable prose changes language.",
  "- Preserve the user's original wording inside quoted input and file contents.",
  `- ${EXPLICIT_LANGUAGE_PRIORITY}`
];

/** Canonicalizes a configured value. Unknown or missing values fall back to
 * `auto`, which preserves the model's own choice when the display language is
 * not one of the supported five. */
export function normalizeOutputLanguage(value: unknown): OutputLanguage {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  return OUTPUT_LANGUAGES.find((language) => language.toLowerCase() === normalized) ?? "auto";
}

/**
 * Maps a VS Code display locale (`vscode.env.language`) to one of the
 * supported languages. Locales Dext does not ship a prompt for return
 * `undefined` so the model keeps deciding from the user's own message instead
 * of being forced into English.
 */
export function outputLanguageFromVscodeLocale(locale: string | undefined): ResolvedOutputLanguage | undefined {
  const normalized = locale?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (normalized === "zh" || /^zh-(cn|sg|hans)(-|$)/.test(normalized)) return "zh-CN";
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(normalized)) return "zh-TW";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  return undefined;
}

/** Resolves the setting for one turn. An explicit language always wins over
 * the display locale; an invalid value behaves like `auto`. `undefined` means
 * no instruction should be injected. */
export function resolveOutputLanguage(
  configured: unknown,
  vscodeLocale: string | undefined
): ResolvedOutputLanguage | undefined {
  const language = normalizeOutputLanguage(configured);
  return language === "auto" ? outputLanguageFromVscodeLocale(vscodeLocale) : language;
}

/** The prompt fragment that steers user-facing text without changing code or
 * the plan/task protocol. Returns `undefined` when no preference is known. */
export function outputLanguageInstruction(language: ResolvedOutputLanguage | undefined): string | undefined {
  if (!language) return undefined;
  return [
    "Interaction language set by Dext:",
    `- Use ${LANGUAGE_NAMES[language]} for every user-facing reply, progress update, visible reasoning summary, and Plan document body.`,
    ...FORMAT_PROTECTION
  ].join("\n");
}

export function conversationLanguageInstruction(language: ResolvedOutputLanguage | null): string {
  return [
    language ? `Use ${LANGUAGE_NAMES[language]} for replies, progress, visible reasoning summaries, and Plan prose.` : undefined,
    "Preserve Plan headings, task numbers and status markers, code, commands, paths, identifiers, quoted text, file contents, and Dext delimiters.",
    "Never translate machine-readable output. Keep JSON keys, schema fields, enum values, type names, and contract values verbatim.",
    EXPLICIT_LANGUAGE_PRIORITY
  ].filter(Boolean).join(" ");
}

export function conversationLanguageOverride(language: ResolvedOutputLanguage | null): string {
  const preference = language ? `Use ${LANGUAGE_NAMES[language]} for user-facing text.`
    : "Clear Dext's language preference and decide from the current user request.";
  return `Dext conversation language override: ${preference}`;
}
