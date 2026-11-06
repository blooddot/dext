export type EditorTokenName =
  | "keyword" | "string" | "number" | "boolean" | "comment" | "function" | "property"
  | "variable" | "identifier" | "type" | "operator" | "punctuation" | "delimiter" | "regexp";

/** How the active theme paints one kind of token. */
export interface EditorTokenStyle {
  foreground?: string;
  /** `italic`, `bold`, `underline`, or a combination, exactly as the theme wrote it. */
  fontStyle?: string;
}

export type EditorTokenTheme = Partial<Record<EditorTokenName, EditorTokenStyle>>;
