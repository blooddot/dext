import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";

describe("MethodRegistry", () => {
  it("tracks source and applies project-over-global-over-builtin precedence", () => {
    const registry = new MethodRegistry();
    const method = BUILTIN_METHODS[0];
    expect(method).toBeDefined();
    registry.register(method!, "builtin");
    registry.register({ ...method!, title: "Global" }, "global");
    registry.register({ ...method!, title: "Project" }, "project");
    registry.register({ ...method!, title: "Late Global" }, "global");
    expect(registry.get(method!.id)).toMatchObject({ title: "Project", source: "project" });
  });

  it("can clear only external definitions", () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    registry.register({ ...BUILTIN_METHODS[0]!, id: "user.chat.respond" }, "global");
    registry.clearExternal();
    expect(registry.list()).toHaveLength(BUILTIN_METHODS.length);
  });
});
