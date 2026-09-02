import { describe, expect, it } from "vitest";
import { formatJsonOutput } from "../src/webview/jsonOutput.js";

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
});
