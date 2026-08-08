import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";

describe("DextLanguageService", () => {
  let service: DextLanguageService;

  beforeEach(() => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    service = new DextLanguageService(registry);
  });

  it("completes methods, parameters, enum values, and references", () => {
    expect(service.completions("core.code").map((item) => item.label)).toContain("core.code.review");
    expect(service.completions("core.code.review(ta").map((item) => item.label)).toContain("target");
    expect(service.completions("core.code.review(target: ").map((item) => item.label)).toContain("@selection");
    expect(
      service.completions("core.code.review(target: @selection, focus: ").map((item) => item.label)
    ).toContain("correctness");
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
      label: expect.stringContaining("target: context")
    });
  });
});
