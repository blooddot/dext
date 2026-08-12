import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";
import type { CallableDefinition } from "../src/core/types.js";

describe("DextLanguageService", () => {
  let service: DextLanguageService;

  beforeEach(() => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    service = new DextLanguageService(registry);
  });

  it("completes method paths one segment at a time", () => {
    expect(service.completions("")).toEqual([
      expect.objectContaining({
        label: "core",
        insertText: "core.",
        detail: "namespace | 3 methods",
        kind: "namespace"
      })
    ]);
    expect(service.completions("c")).toEqual([
      expect.objectContaining({ label: "core", insertText: "core.", kind: "namespace" })
    ]);
    expect(service.completions("core.").map((item) => item.label)).toEqual([
      "chat",
      "code",
      "context"
    ]);
    expect(service.completions("core.c").map((item) => item.label)).toEqual([
      "chat",
      "code",
      "context"
    ]);
    expect(service.completions("core.chat.")).toEqual([
      expect.objectContaining({
        label: "respond",
        insertText: "respond(",
        detail: expect.stringContaining("command method"),
        kind: "method"
      })
    ]);
    expect(service.completions("core.code.").map((item) => item.label)).toEqual(["review"]);
    expect(service.completions("core.context.").map((item) => item.label)).toEqual(["snapshot"]);
  });

  it("completes parameters, enum values, and references", () => {
    const parameterSource = "core.code.review(ta";
    expect(service.completions(parameterSource)).toContainEqual(expect.objectContaining({
      label: "target",
      replaceStart: parameterSource.indexOf("ta"),
      replaceEnd: parameterSource.length
    }));

    expect(service.completions("core.code.review(target: ").map((item) => item.label)).toEqual([
      "@selection",
      "@activeFile",
      "@file",
      "@symbol"
    ]);
    expect(service.completions("core.code.review(target: @fi").map((item) => item.label)).toEqual([
      "@file"
    ]);
    expect(service.completions("core.code.review(target: @activeFile")).toEqual([]);
    expect(service.completions("core.code.review(target: @file(")).toEqual([]);
    expect(service.completions('core.code.review(target: @file("")')).toEqual([]);
    expect(service.completions('core.code.review(target: @file("src/fi')).toEqual([]);

    expect(
      service.completions("core.code.review(target: @selection, focus: c").map((item) => item.label)
    ).toEqual(["correctness"]);
    expect(service.completions('core.code.review(target: @selection, focus: "correctness"')).toEqual([]);
  });

  it("filters boolean values and stops after a complete value", () => {
    const definition: CallableDefinition = {
      id: "test.toggle",
      title: "Toggle",
      description: "Toggle a setting.",
      kind: "command",
      version: "1.0.0",
      input: [{ name: "enabled", type: "boolean", required: true }],
      output: { kind: "text" },
      executor: { kind: "deterministic", handler: "toggle" }
    };
    const registry = new MethodRegistry();
    registry.register(definition, "project");
    const booleanService = new DextLanguageService(registry);

    expect(booleanService.completions("test.toggle(enabled: t").map((item) => item.label)).toEqual(["true"]);
    expect(booleanService.completions("test.toggle(enabled: true")).toEqual([]);
  });

  it("replaces only the current method path segment", () => {
    const source = "core.coZZ";
    const completions = service.completions(source, "core.co".length);
    expect(completions.map((item) => item.label)).toEqual(["code", "context"]);
    expect(completions).toEqual(completions.map((item) => ({ ...item, replaceStart: 5, replaceEnd: 9 })));
  });

  it("stops completing after the method call is closed", () => {
    expect(service.completions("core.code.review(target: @activeFile)")).toEqual([]);
    expect(service.completions('core.code.review(target: @file("src/app.ts"))')).toEqual([]);
  });

  it("reports semantic diagnostics", () => {
    expect(service.diagnostics("core.code.review(focus: 2)").map((item) => item.message)).toEqual([
      "Argument 'focus' does not match focus?: correctness | maintainability | security.",
      "Missing required argument 'target'."
    ]);
  });

  it("provides signature help", () => {
    expect(service.signature("core.code.review(target: @selection, ")).toMatchObject({
      activeParameter: 1,
      label: expect.stringContaining("target: context"),
      parameters: [expect.objectContaining({ label: "target: context" }), expect.any(Object)]
    });
    expect(service.signature('core.code.review(target: @file("a,b"), focus: ')).toMatchObject({
      activeParameter: 1
    });
    expect(service.signature('core.code.review(target: ["a,b", "c"], focus: ')).toMatchObject({
      activeParameter: 1
    });
    expect(service.signature("core.code.review(target: @selection)")).toBeUndefined();
  });

  it("provides method and parameter hover content", () => {
    const source = "core.code.review(target: @selection)";
    expect(service.hover(source, source.indexOf("code"))).toMatchObject({
      rangeStart: 0,
      rangeEnd: "core.code.review".length,
      label: expect.stringContaining("-> review"),
      documentation: expect.stringContaining("structured review")
    });
    expect(service.hover(source, source.indexOf("target") + 1)).toMatchObject({
      rangeStart: source.indexOf("target"),
      rangeEnd: source.indexOf("target") + "target".length,
      label: "target: context",
      documentation: expect.stringContaining("Required")
    });
  });
});
