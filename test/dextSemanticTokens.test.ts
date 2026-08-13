import { describe, expect, it } from "vitest";
import { dextSemanticTokens } from "../src/dextSemanticTokens.js";

describe("Dext semantic tokens", () => {
  it("classifies API declarations and calls using standard VS Code token types", () => {
    const source = `from team import explain

def main(target: Context) -> ReviewResult:
    analysis = code.explain(target=target)
    return code.review(target=target, instruction=analysis.text)
`;
    const tokens = dextSemanticTokens(source).map((token) => ({
      text: source.slice(token.from, token.to),
      type: token.type,
      declaration: token.declaration ?? false
    }));

    expect(tokens).toContainEqual({ text: "main", type: "function", declaration: true });
    expect(tokens).toContainEqual({ text: "target", type: "parameter", declaration: true });
    expect(tokens).toContainEqual({ text: "Context", type: "type", declaration: false });
    expect(tokens).toContainEqual({ text: "ReviewResult", type: "type", declaration: false });
    expect(tokens).toContainEqual({ text: "code", type: "namespace", declaration: false });
    expect(tokens).toContainEqual({ text: "review", type: "function", declaration: false });
    expect(tokens).toContainEqual({ text: "instruction", type: "parameter", declaration: false });
    expect(tokens).toContainEqual({ text: "text", type: "property", declaration: false });
  });
});
