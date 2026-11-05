import { describe, expect, it } from "vitest";
import { dextMarkdown } from "../src/shared/lib/markdown.js";
import { markdownCodeCopy } from "../src/shared/lib/markdownCopy.js";
import { codeLanguageId } from "../src/shared/lib/codeLanguage.js";

describe("fenced code language", () => {
  it("maps the tags a reply uses to a registered Monarch grammar", () => {
    expect(codeLanguageId("CSS")).toBe("css");
    expect(codeLanguageId("ts")).toBe("typescript");
    expect(codeLanguageId("bash")).toBe("shell");
    expect(codeLanguageId("python")).toBe("python");
    // An unregistered grammar must not be invented: the block stays plain text.
    expect(codeLanguageId("sql")).toBeUndefined();
    expect(codeLanguageId("")).toBeUndefined();
  });

  it("keeps the language on the code element the colorizer reads", () => {
    const markdown = dextMarkdown();
    markdown.use(markdownCodeCopy);
    const html = markdown.render("```css\n.x { color: red }\n```");
    // `colorizeCodeBlocks` selects `pre > code[class*='language-']`.
    expect(html).toContain('<code class="language-css">');
  });
});
