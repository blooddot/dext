import { describe, expect, it } from "vitest";
import { scanPython } from "../src/core/projectArchitecturePython.js";

describe("Python architecture scan", () => {
  it("finds package imports", () => {
    const result = scanPython([{ path: "app/a.py", content: "from app.b import value" }, { path: "app/b.py", content: "value = 1" }]);
    expect(result.relations[0]?.to).toBe("app/b");
  });
});
