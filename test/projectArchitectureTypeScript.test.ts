import { describe, expect, it } from "vitest";
import { scanTypeScript } from "../src/core/projectArchitectureTypeScript.js";

describe("TypeScript architecture scan", () => {
  it("finds relative imports", () => {
    const result = scanTypeScript([{ path: "src/a.ts", content: "import { b } from './b';" }, { path: "src/b.ts", content: "export const b = 1;" }]);
    expect(result.relations[0]).toMatchObject({ from: "src/a", to: "src/b", source: "detected" });
  });
});
