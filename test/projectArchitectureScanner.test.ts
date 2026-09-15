import { describe, expect, it } from "vitest";
import { scanProjectArchitecture } from "../src/core/projectArchitectureScanner.js";

describe("scanProjectArchitecture", () => {
  it("combines supported languages and reports unsupported files", () => {
    const result = scanProjectArchitecture([
      { path: "src/a.ts", content: "import './b';" },
      { path: "src/b.ts", content: "export const b = 1;" },
      { path: "pkg/a.py", content: "from .b import value" },
      { path: "pkg/b.py", content: "value = 1" },
      { path: "README.md", content: "docs" },
    ]);
    expect(result.modules).toHaveLength(4);
    expect(result.relations).toHaveLength(2);
    expect(result.unsupported).toEqual([{ path: "README.md", reason: "Unsupported language." }]);
    expect(result.parserVersions.typescript).toBeTruthy();
    expect(result.parserVersions.python).toBeTruthy();
  });
});
