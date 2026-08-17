import { describe, expect, it } from "vitest";
import { dextSemanticTokens } from "../src/dextSemanticTokens.js";

describe("Dext semantic tokens", () => {
  it("classifies API declarations and calls using standard VS Code token types", () => {
    const source = `def main(input: str) -> ChatResult:
    analysis = ask(input=input)
    return agent(input=analysis.text, apply=False)
`;
    const tokens = dextSemanticTokens(source).map((token) => ({
      text: source.slice(token.from, token.to),
      type: token.type,
      declaration: token.declaration ?? false
    }));

    expect(tokens).toContainEqual({ text: "main", type: "function", declaration: true });
    expect(tokens).toContainEqual({ text: "input", type: "parameter", declaration: true });
    expect(tokens).toContainEqual({ text: "str", type: "type", declaration: false });
    expect(tokens).toContainEqual({ text: "ChatResult", type: "type", declaration: false });
    expect(tokens).toContainEqual({ text: "ask", type: "function", declaration: false });
    expect(tokens).toContainEqual({ text: "agent", type: "function", declaration: false });
    expect(tokens).toContainEqual({ text: "apply", type: "parameter", declaration: false });
    expect(tokens).toContainEqual({ text: "text", type: "property", declaration: false });
  });
});
