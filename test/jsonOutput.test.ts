import { describe, expect, it } from "vitest";
import { formatJsonOutput } from "../src/shared/lib/jsonOutput.js";

describe("JSON output formatting", () => {
  it("pretty-prints complete object output without dropping nested fields", () => {
    const raw = JSON.stringify({
      result: {
        content: "[CR][Summary] 代码审查问题汇总\n\n### 1. [Medium] 释放资源",
        note: "审查来源: release/a → release/b"
      },
      involveMembers: ["guohong"]
    });
    const formatted = formatJsonOutput(raw);
    expect(formatted).toContain('"result": {\n');
    expect(formatted).toContain('"content": "[CR][Summary] 代码审查问题汇总\\n\\n### 1. [Medium] 释放资源"');
    expect(formatted).toContain('"involveMembers": [\n    "guohong"\n  ]');
  });

  it("does not reinterpret plain text or malformed JSON", () => {
    expect(formatJsonOutput("普通输出")).toBeUndefined();
    expect(formatJsonOutput("{not-json}")).toBeUndefined();
    expect(formatJsonOutput('"plain string"')).toBeUndefined();
  });

  it.each(['prefix {"a":1}', '{"a":1} suffix', '```json\n{}\n```', '{"a":', '[1,',
    '{"a":1,}', '{/* comment */"a":1}', 'null', '42', 'true'])("rejects non-complete object/array output: %s", (raw) => {
    expect(formatJsonOutput(raw)).toBeUndefined();
  });

  it("only changes whitespace, preserving JSON lexemes that parsing and stringifying would lose", () => {
    const raw = String.raw`{"n":9007199254740993,"n":1e400,"escaped":"\u4e2d\n\"\\**bold**"}`;
    const formatted = formatJsonOutput(raw)!;
    expect(formatted).toContain('9007199254740993');
    expect(formatted).toContain('1e400');
    expect(formatted.match(/"n"/g)).toHaveLength(2);
    expect(formatted).toContain(String.raw`\u4e2d\n\"\\**bold**`);
  });
});
