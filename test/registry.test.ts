import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";

describe("MethodRegistry", () => {
  it("keeps builtin API contracts reserved", () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    registry.register({
      ...BUILTIN_METHODS[0]!,
      title: "Project override"
    }, "project");
    expect(registry.get("ask")?.title).toBe("Ask");
    expect(registry.get("chat")).toBeUndefined();
  });
});
