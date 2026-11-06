/** Languages Dext can ask a provider to use for user-facing text. `auto` is
 * resolved from the VS Code display language; only the concrete values are
 * ever injected into a prompt. */
export const OUTPUT_LANGUAGES = ["auto", "zh-CN", "zh-TW", "en", "ja", "ko"] as const;

export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

/** A language that can be written into a prompt. `auto` is not one: it has to
 * be resolved against the editor's display language first. */
export type ResolvedOutputLanguage = Exclude<OutputLanguage, "auto">;

const LANGUAGE_NAMES: Record<ResolvedOutputLanguage, string> = {
  "zh-CN": "Simplified Chinese (zh-CN)",
  "zh-TW": "Traditional Chinese (zh-TW)",
  en: "English (en)",
  ja: "Japanese (ja)",
  ko: "Korean (ko)"
};

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
    "- Keep the structure and protocol intact: do not translate section headings required by the Plan format, task checklist numbering or status markers, code, commands, file paths, identifiers, quoted source text, or Dext delimiter lines.",
    "- Never translate machine-readable output: JSON keys, schema field names, enum values, type names, and any value the response contract defines. Only human-readable prose changes language.",
    "- Preserve the user's original wording inside quoted input and file contents.",
    "- If the user explicitly asks for another language or a translation in this turn, follow that request instead."
  ].join("\n");
}
