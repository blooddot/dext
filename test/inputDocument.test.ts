import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";

describe("Strict workflow document", () => {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const service = new DextLanguageService(registry);

  it("does not classify free text as chat", () => {
    expect(service.documentDiagnostics("Please explain this")).not.toEqual([]);
  });

  it("accepts explicit chat code", () => {
    expect(service.documentDiagnostics('ask(input="Please explain this")')).toEqual([]);
  });
});
