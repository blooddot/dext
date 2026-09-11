import { describe, expect, it } from "vitest";
import { pythonType, splitTopLevel } from "../src/core/pythonType.js";

describe("Python type translation", () => {
  it("translates Dext scalar names and array suffixes", () => {
    expect(pythonType("string")).toBe("str");
    expect(pythonType("boolean[]")).toBe("list[bool]");
    expect(pythonType("number[]")).toBe("list[float]");
    expect(pythonType("list[string | ui.Option]")).toBe("list[str | ui.Option]");
    expect(pythonType("string | undefined")).toBe("str | None");
    expect(pythonType('"safe" | "fast" | result | ("safe" | "fast" | result)[]'))
      .toBe('"safe" | "fast" | result | list[("safe" | "fast" | result)]');
  });

  it("keeps object as the dict value type", () => {
    expect(pythonType("object")).toBe("dict");
    expect(pythonType("dict[str, object]")).toBe("dict[str, object]");
    expect(pythonType("dict[str, object][]")).toBe("list[dict[str, object]]");
  });

  it("rewrites optional shape members instead of leaking TypeScript markers", () => {
    expect(pythonType("{ id: string, type?: string }")).toBe("{ id: str, type: str | None }");
    expect(pythonType("{ answers: { selected?: list[string] } }")).toBe("{ answers: { selected: list[str] | None } }");
    expect(pythonType("{ type?: string }[]")).toBe("list[{ type: str | None }]");
  });

  it("splits only outside quotes and brackets", () => {
    expect(splitTopLevel('a, b, { c, d }, list[e, f], "g, h"', ","))
      .toEqual(["a", " b", " { c, d }", " list[e, f]", ' "g, h"']);
  });
});
