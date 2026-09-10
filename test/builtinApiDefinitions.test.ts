import { describe, expect, it } from "vitest";
import { builtinApiDefinition, builtinApiDocument, builtinApiNamespace, builtinApiReferenceTarget } from "../src/core/builtinApiDefinitions.js";

describe("built-in API definitions", () => {
  it("renders registered APIs, including Node bridges, into a navigable document", () => {
    expect(builtinApiDefinition("node.url.parse")?.title).toBe("URL parse");
    expect(builtinApiNamespace("node.url")).toBe(true);
    const document = builtinApiDocument();
    const range = document.ranges.get("node.url.parse")!;
    expect(document.text.slice(range.nameFrom, range.nameTo)).toBe("parse");
    expect(document.text).toContain("class node:");
    expect(document.text).toContain("class url:");
    expect(document.text).toContain("def parse(");
    expect(document.text).toContain("def agent(");
    expect(document.text).toContain(") -> AgentResult:\n    ...");
    expect(builtinApiReferenceTarget(document.text, document.text.indexOf("node.url.parse") + 6)).toMatchObject({ id: "node.url.parse" });
    const urlClass = document.text.indexOf("class url");
    expect(builtinApiReferenceTarget(document.text, urlClass + 7)).toMatchObject({ id: "node.url" });
    expect(builtinApiReferenceTarget(document.text, document.text.indexOf("def parse", urlClass) + 5)).toMatchObject({ id: "node.url.parse" });
  });
});
