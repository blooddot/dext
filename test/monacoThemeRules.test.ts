import { describe, expect, it } from "vitest";
import { monacoColor, monacoThemeRules } from "../src/webview/monacoThemeRules.js";

/**
 * Monaco's TypeScript tokenizer emits `keyword`, `identifier`, `string`, `number`,
 * `comment`, `regexp`, `type.identifier` and the `delimiter*` family. Only mapping the
 * value types — keyword, string, number, comment — left every name, brace, parenthesis
 * and semicolon on Monaco's own default color, so the composer looked like a different
 * theme from the editor beside it. These rules are what `applyMonacoTheme` installs.
 */
describe("the active theme as Monaco token rules", () => {
  it("colors every token type the TypeScript grammar emits", () => {
    const rules = monacoThemeRules({
      keyword: { foreground: "#111111" },
      identifier: { foreground: "#222222" },
      string: { foreground: "#333333" },
      number: { foreground: "#444444" },
      comment: { foreground: "#555555", fontStyle: "italic" },
      delimiter: { foreground: "#666666" },
      regexp: { foreground: "#777777" },
      type: { foreground: "#888888" }
    });
    const foreground = (token: string): string | undefined => rules.find((rule) => rule.token === token)?.foreground;
    expect(foreground("keyword")).toBe("111111");
    expect(foreground("identifier")).toBe("222222");
    expect(foreground("string")).toBe("333333");
    expect(foreground("number")).toBe("444444");
    expect(rules.find((rule) => rule.token === "comment")).toEqual({ token: "comment", foreground: "555555", fontStyle: "italic" });
    // One rule covers `delimiter`, `delimiter.bracket` and `delimiter.parenthesis`:
    // Monaco matches a token type by its dot-separated prefix.
    expect(foreground("delimiter")).toBe("666666");
    expect(foreground("regexp")).toBe("777777");
    expect(foreground("type")).toBe("888888");
    expect(rules.some((rule) => rule.token === "delimiter.bracket")).toBe(false);
  });

  it("keeps a style-only rule and drops the slots the theme does not set", () => {
    const rules = monacoThemeRules({ comment: { fontStyle: "italic" }, keyword: { foreground: "not-a-color" } });
    expect(rules).toEqual([{ token: "comment", fontStyle: "italic" }]);
  });

  it("accepts the shorthand hex a theme may write and ignores anything else", () => {
    expect(monacoColor("#abc")).toBe("aabbcc");
    expect(monacoColor("#aabbccdd")).toBe("aabbccdd");
    expect(monacoColor("#123456")).toBe("123456");
    expect(monacoColor("rgba(1,2,3,1)")).toBeUndefined();
    expect(monacoThemeRules(undefined)).toEqual([]);
  });
});
