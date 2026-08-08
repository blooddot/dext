import { describe, expect, it } from "vitest";
import { parseInvocation } from "../src/core/dsl.js";

describe("Dext DSL", () => {
  it("parses named values, arrays, and context references", () => {
    expect(
      parseInvocation(
        'core.code.review(target: @file("src/app.ts"), focus: ["correctness", "security"], enabled: true, limit: 3)'
      )
    ).toEqual({
      kind: "invocation",
      method: "core.code.review",
      source: "code",
      arguments: [
        { name: "target", value: { kind: "file", path: "src/app.ts" } },
        { name: "focus", value: ["correctness", "security"] },
        { name: "enabled", value: true },
        { name: "limit", value: 3 }
      ]
    });
  });

  it("parses selection and symbol references", () => {
    expect(parseInvocation('x.y(first: @selection, second: @symbol("User"))').arguments).toEqual([
      { name: "first", value: { kind: "selection" } },
      { name: "second", value: { kind: "symbol", name: "User" } }
    ]);
  });

  it("rejects more than one invocation", () => {
    expect(() => parseInvocation("core.chat.respond(message: \"a\") other()"))
      .toThrow("Only one method invocation is allowed");
  });
});
