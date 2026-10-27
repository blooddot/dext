import { describe, expect, it } from "vitest";
import {
  OUTPUT_LANGUAGES,
  normalizeOutputLanguage,
  outputLanguageFromVscodeLocale,
  outputLanguageInstruction,
  resolveOutputLanguage,
  type ResolvedOutputLanguage
} from "../src/features/agents/domain/outputLanguage.js";

describe("output language contract", () => {
  it("exposes the setting values in display order", () => {
    expect(OUTPUT_LANGUAGES).toEqual(["auto", "zh-CN", "zh-TW", "en", "ja", "ko"]);
  });

  it.each(OUTPUT_LANGUAGES)("normalizes the configured value %s", (value) => {
    expect(normalizeOutputLanguage(value)).toBe(value);
    expect(normalizeOutputLanguage(` ${value.toLowerCase()} `)).toBe(value);
  });

  it("falls back to auto for missing and unsupported configured values", () => {
    for (const value of [undefined, null, "", "  ", "fr", "english", 3, {}, []]) {
      expect(normalizeOutputLanguage(value)).toBe("auto");
    }
  });

  it("maps Simplified Chinese display locales", () => {
    for (const locale of ["zh-cn", "zh-CN", "zh", "zh-hans", "zh-Hans-CN", "zh-sg", "zh_CN"]) {
      expect(outputLanguageFromVscodeLocale(locale)).toBe("zh-CN");
    }
  });

  it("maps Traditional Chinese display locales without confusing them with Simplified", () => {
    for (const locale of ["zh-tw", "zh-TW", "zh-hk", "zh-mo", "zh-hant", "zh-Hant-TW", "zh_TW"]) {
      expect(outputLanguageFromVscodeLocale(locale)).toBe("zh-TW");
    }
    expect(outputLanguageFromVscodeLocale("zh-xx")).toBeUndefined();
  });

  it("maps English, Japanese, and Korean regional locales", () => {
    expect(outputLanguageFromVscodeLocale("en")).toBe("en");
    expect(outputLanguageFromVscodeLocale("en-US")).toBe("en");
    expect(outputLanguageFromVscodeLocale("en-GB")).toBe("en");
    expect(outputLanguageFromVscodeLocale("ja")).toBe("ja");
    expect(outputLanguageFromVscodeLocale("ja-JP")).toBe("ja");
    expect(outputLanguageFromVscodeLocale("ko")).toBe("ko");
    expect(outputLanguageFromVscodeLocale("ko-KR")).toBe("ko");
  });

  it("leaves unsupported, empty, and missing display languages unresolved", () => {
    for (const locale of ["fr", "fr-FR", "de-DE", "es", "", "  ", undefined]) {
      expect(outputLanguageFromVscodeLocale(locale)).toBeUndefined();
    }
  });

  it("prefers an explicit configured language over the display language", () => {
    expect(resolveOutputLanguage("en", "zh-cn")).toBe("en");
    expect(resolveOutputLanguage("zh-TW", "en-US")).toBe("zh-TW");
    expect(resolveOutputLanguage("ja", "ko-KR")).toBe("ja");
  });

  it("resolves auto from the display locale", () => {
    expect(resolveOutputLanguage("auto", "zh-cn")).toBe("zh-CN");
    expect(resolveOutputLanguage("auto", "en-US")).toBe("en");
    expect(resolveOutputLanguage("auto", "fr")).toBeUndefined();
    // A missing setting is the same as auto, which is how a manifest default
    // and an old workspace value behave.
    expect(resolveOutputLanguage(undefined, "ja-JP")).toBe("ja");
  });

  it("treats an invalid configured value as auto", () => {
    expect(resolveOutputLanguage("fr", "zh-cn")).toBe("zh-CN");
    expect(resolveOutputLanguage("not-a-language", "en")).toBe("en");
    expect(resolveOutputLanguage(42, "fr")).toBeUndefined();
  });

  it.each<ResolvedOutputLanguage>(["zh-CN", "zh-TW", "en", "ja", "ko"])(
    "builds an instruction for %s",
    (language) => {
      const instruction = outputLanguageInstruction(language);
      expect(instruction).toContain("Interaction language set by Dext");
      expect(instruction).toContain(language);
      for (const protectedContent of [
        "section headings",
        "task checklist",
        "status markers",
        "code",
        "commands",
        "file paths",
        "identifiers",
        "quoted source text",
        "delimiter lines"
      ]) {
        expect(instruction).toContain(protectedContent);
      }
      expect(instruction).toContain("user explicitly asks for another language");
    }
  );

  it("injects nothing when no language is resolved", () => {
    expect(outputLanguageInstruction(undefined)).toBeUndefined();
  });
});
