import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseTemplate,
  renderTemplateText,
  templateFormatError,
  templateInstruction,
  templateOutputSchema,
  templatePreset,
  templateValues
} from "../src/core/templateRender.js";

const ADR = `---
dext-template:
  format: markdown
  number: ADR 编号，四位数字字符串，例如 "0081"
  title: 简短标题，体现决策内容而不是问题描述
  status:
    type: enum
    values: [accepted, rejected, deprecated]
    description: 决策状态
  module: 模块/子模块，如 optimize/fund-grid
  related_bep: 关联的 BEP 编号和链接；没有则写 None
  context: 什么问题促使了这个决策，只说问题和约束
  decision: 直接说选择了什么
  positive:
    type: lines
    description: 正面后果，每条一句话
  negative:
    type: lines
    description: 负面后果，每条一句话
  sources:
    type: lines
    optional: true
    description: 外部理论/论文/标准来源，纯项目实验留空
  validation:
    type: string
    optional: true
    description: 验证记录、版本号、日期
---

# ADR-{{number}}: {{title}}

## 状态

{{status}}

## 模块

{{module}}

## Related BEP

{{related_bep}}

## 背景

{{context}}

## 决策

{{decision}}

## 后果

### 正面

- {{positive}}

### 负面

- {{negative}}

## 参考资料

- {{sources}}

## 验证（如适用）

{{validation}}
`;

const values = {
  number: "0081",
  title: "多轮搜索选择 Medoid",
  status: "accepted",
  module: "optimize",
  related_bep: "[BEP-0021](../proposals/BEP-0021.md)",
  context: "逐字段聚合会拼出从未共同出现过的参数。",
  decision: "1. 选择实际 Round 的完整参数。\n2. 用标准化距离取 medoid。",
  positive: "保留参数联动关系\n不增加 trial 成本",
  negative: "- 不保证最高历史收益\n- 距离依赖搜索范围",
  sources: "- 申万宏源, [分类列表](https://example.com/a.xls)",
  validation: "[BEP-0021-r01](../proposals/validation/BEP-0021-r01.md) 同池回测通过。"
};

describe("templateRender", () => {
  it("reads the field declarations and the body", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    expect(spec.fields.map((field) => field.name)).toEqual([
      "number", "title", "status", "module", "related_bep", "context", "decision", "positive", "negative", "sources", "validation"
    ]);
    expect(spec.fields.find((field) => field.name === "status")!.values).toEqual(["accepted", "rejected", "deprecated"]);
    expect(spec.fields.find((field) => field.name === "sources")!.optional).toBe(true);
    expect(spec.fields.find((field) => field.name === "positive")!.type).toBe("lines");
    expect(spec.body.trimStart().startsWith("# ADR-{{number}}: {{title}}")).toBe(true);
  });

  it("rejects a template without front matter", () => {
    expect(() => parseTemplate("# Title\n", "t.md")).toThrow(/front matter/);
  });

  it("rejects a placeholder that no field declares", () => {
    const source = ADR.replace("{{module}}", "{{missing}}");
    expect(() => parseTemplate(source, "t.md")).toThrow(/does not declare/);
  });

  it("rejects a declared field the body never uses", () => {
    const source = ADR.replace("## Related BEP\n\n{{related_bep}}\n\n", "");
    expect(() => parseTemplate(source, "t.md")).toThrow(/never used/);
  });

  it("rejects two lines fields on one line", () => {
    const source = ADR.replace("- {{positive}}", "- {{positive}} {{negative}}");
    expect(() => parseTemplate(source, "t.md")).toThrow(/more than one 'lines' field/);
  });
});

describe("renderTemplateText", () => {
  it("renders every section in template order", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    const text = renderTemplateText(spec, values);
    expect(text).toBe([
      "# ADR-0081: 多轮搜索选择 Medoid",
      "",
      "## 状态",
      "",
      "accepted",
      "",
      "## 模块",
      "",
      "optimize",
      "",
      "## Related BEP",
      "",
      "[BEP-0021](../proposals/BEP-0021.md)",
      "",
      "## 背景",
      "",
      "逐字段聚合会拼出从未共同出现过的参数。",
      "",
      "## 决策",
      "",
      "1. 选择实际 Round 的完整参数。",
      "2. 用标准化距离取 medoid。",
      "",
      "## 后果",
      "",
      "### 正面",
      "",
      "- 保留参数联动关系",
      "- 不增加 trial 成本",
      "",
      "### 负面",
      "",
      "- 不保证最高历史收益",
      "- 距离依赖搜索范围",
      "",
      "## 参考资料",
      "",
      "- 申万宏源, [分类列表](https://example.com/a.xls)",
      "",
      "## 验证（如适用）",
      "",
      "[BEP-0021-r01](../proposals/validation/BEP-0021-r01.md) 同池回测通过。",
      ""
    ].join("\n"));
  });

  it("drops an optional section together with its heading", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    const text = renderTemplateText(spec, { ...values, sources: "", validation: "  " });
    expect(text).not.toContain("## 参考资料");
    expect(text).not.toContain("## 验证");
    expect(text.endsWith("- 距离依赖搜索范围\n")).toBe(true);
  });

  it("strips bullet markers the model added anyway", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    const text = renderTemplateText(spec, { ...values, positive: "- 保留参数联动关系\n* 不增加 trial 成本\n+ 第三条" });
    expect(text).toContain("- 保留参数联动关系\n- 不增加 trial 成本\n- 第三条");
    expect(text).not.toContain("* 不增加");
  });

  it("keeps one optional section when the other is empty", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    const text = renderTemplateText(spec, { ...values, sources: "" });
    expect(text).not.toContain("## 参考资料");
    expect(text).toContain("## 验证（如适用）");
    expect(text.trimEnd().endsWith("同池回测通过。")).toBe(true);
  });
});

describe("templateOutputSchema", () => {
  it("declares one required field per template field", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    const json = JSON.parse(JSON.stringify(z.toJSONSchema(templateOutputSchema(spec)))) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(json.properties)).toEqual(["kind", "number", "title", "status", "module", "related_bep", "context", "decision", "positive", "negative", "sources", "validation"]);
    expect(json.required).toContain("positive");
    expect(json.required).not.toContain("sources");
  });

  it("preset fields are excluded from the model contract", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    const preset = templatePreset(spec, { number: "0081", module: "optimize" });
    expect([...preset.names]).toEqual(["number", "module"]);
    const json = JSON.parse(JSON.stringify(z.toJSONSchema(templateOutputSchema(spec, preset)))) as { properties: Record<string, unknown> };
    expect(Object.keys(json.properties)).not.toContain("number");
    expect(templateValues(spec, { number: "9999", title: "t" }, preset.values).number).toBe("0081");
    expect(templateValues(spec, { title: "t" }, preset.values).title).toBe("t");
  });

  it("rejects an unknown preset field and an out-of-range enum", () => {
    const spec = parseTemplate(ADR, "adr-template.md");
    expect(() => templatePreset(spec, { nope: "x" })).toThrow(/does not declare/);
    expect(() => templatePreset(spec, { status: "maybe" })).toThrow(/must be one of/);
  });
});

const JSON_TEMPLATE = `---
dext-template:
  format: json
  name: 包名，kebab-case
  version: 版本号，例如 0.1.0，带引号注入
  keywords:
    type: lines
    separator: ",\\n"
    description: 关键词，每个写成带双引号的 JSON 字符串
---

{
  "name": "{{name}}",
  "version": "{{version}}",
  "keywords": [
    {{keywords}}
  ]
}
`;

function sectionTemplate(format: string): string {
  return `---
dext-template:
  format: ${format}
  empty:
    type: string
    optional: true
  body: 正文
---

# Section

{{empty}}

# Next

{{body}}
`;
}

describe("template formats", () => {
  it("requires the format option, and reads it case-insensitively", () => {
    expect(parseTemplate(ADR, "adr-template.md").format).toBe("markdown");
    expect(parseTemplate(JSON_TEMPLATE, "package.json.tpl").format).toBe("json");
    expect(parseTemplate(JSON_TEMPLATE.replace("format: json", "format: JSON"), "t.md").format).toBe("json");
    expect(() => parseTemplate(JSON_TEMPLATE.replace("  format: json\n", ""), "t.md")).toThrow(/must declare 'format'/);
  });

  it("joins a lines field with its separator so a JSON array needs no trailing comma", () => {
    const spec = parseTemplate(JSON_TEMPLATE, "package.json.tpl");
    // The separator only sits *between* the repeated lines; the indentation is
    // the placeholder line's own, so a comma is all it needs to add.
    expect(spec.fields.find((field) => field.name === "keywords")?.separator).toBe(",\n");
    const text = renderTemplateText(spec, { name: "pkg", version: "0.1.0", keywords: '"a"\n"b"' });
    expect(text).toBe([
      "{",
      '  "name": "pkg",',
      '  "version": "0.1.0",',
      '  "keywords": [',
      '    "a",',
      '    "b"',
      "  ]",
      "}",
      ""
    ].join("\n"));
    expect(JSON.parse(text)).toEqual({ name: "pkg", version: "0.1.0", keywords: ["a", "b"] });
  });

  it("makes an invalid render a contract failure without leaking the option into the model schema", () => {
    const spec = parseTemplate(JSON_TEMPLATE, "package.json.tpl");
    const schema = templateOutputSchema(spec);
    expect(schema.safeParse({ kind: "template", name: "pkg", version: "0.1.0", keywords: '"a"' }).success).toBe(true);
    const bad = schema.safeParse({ kind: "template", name: 'a"b', version: "0.1.0", keywords: '"a"' });
    expect(bad.success).toBe(false);
    expect(bad.success ? "" : bad.error.issues[0]?.message).toContain("Rendered JSON is invalid");
    // The provider still receives the plain field schema: a refinement is not
    // representable in JSON Schema, and `format` is an option, not a field.
    const json = JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as { properties: Record<string, unknown> };
    expect(Object.keys(json.properties)).toEqual(["kind", "name", "version", "keywords"]);
  });

  it("checks toml and yaml renders, and leaves markdown and text unchecked", () => {
    const toml = parseTemplate("---\ndext-template:\n  format: toml\n  name: 包名\n---\n\n[name]\nvalue = \"{{name}}\"\n", "cargo.toml.tpl");
    expect(toml.format).toBe("toml");
    expect(templateOutputSchema(toml).safeParse({ kind: "template", name: "x" }).success).toBe(true);
    expect(templateOutputSchema(toml).safeParse({ kind: "template", name: 'a"b' }).success).toBe(false);
    expect(templateFormatError("toml", 'value = "unterminated')).toContain("TOML is invalid");
    expect(templateFormatError("yaml", "a: [1, 2")).toContain("YAML is invalid");
    expect(templateFormatError("markdown", "# anything")).toBeUndefined();
    expect(templateFormatError("text", "anything")).toBeUndefined();
  });

  it("renders text literally instead of applying the Markdown section rules", () => {
    const values = { empty: "", body: "正文" };
    const markdown = renderTemplateText(parseTemplate(sectionTemplate("markdown"), "t.md"), values);
    const text = renderTemplateText(parseTemplate(sectionTemplate("text"), "t.txt"), values);
    // The empty optional field emptied the section, so Markdown drops it whole.
    expect(markdown).toBe("# Next\n\n正文\n");
    // Text keeps the template exactly as written, blank lines included.
    expect(text).toBe("# Section\n\n\n# Next\n\n正文\n");
  });

  it("keeps list markers in a non-Markdown format and strips them only in Markdown", () => {
    const source = (format: string) => `---\ndext-template:\n  format: ${format}\n  items:\n    type: lines\n    separator: "\\n"\n---\n\n{{items}}\n`;
    expect(renderTemplateText(parseTemplate(source("text"), "t.txt"), { items: "- a\n- b" })).toBe("- a\n- b\n");
    expect(renderTemplateText(parseTemplate(source("markdown"), "t.md"), { items: "- a\n- b" })).toBe("a\nb\n");
  });

  it("rejects a separator on a non-lines field", () => {
    const separator = "---\ndext-template:\n  format: markdown\n  a:\n    separator: \", \"\n---\n\n{{a}}\n";
    expect(() => parseTemplate(separator, "t.md")).toThrow(/only a lines field/);
  });

  it("reserves the format name for the option", () => {
    // A field cannot hide the format: the option is how the render is checked.
    const asField = "---\ndext-template:\n  format:\n    description: 输出格式名\n---\n\n{{format}}\n";
    expect(() => parseTemplate(asField, "t.md")).toThrow(/no field may be named 'format'/);
    const unknown = "---\ndext-template:\n  format: toml-ish\n  a: 说明\n---\n\n{{a}}\n";
    expect(() => parseTemplate(unknown, "t.md")).toThrow(/must be declared as one of/);
  });

  it("tells the model what the format asks of its field values", () => {
    const json = templateInstruction(parseTemplate(JSON_TEMPLATE, "package.json.tpl"));
    expect(json).toContain("as JSON");
    expect(json).toContain("must parse as valid JSON");
    expect(json).toContain("inserted verbatim");
    expect(templateInstruction(parseTemplate(ADR, "adr-template.md"))).toBe(
      "Dext renders your field values into 'adr-template.md' as MARKDOWN. "
      + "The structure around each field comes from the template, never from your answer: never write the file's headings, keys, list markers or section order yourself."
    );
  });
});
