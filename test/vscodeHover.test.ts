import { describe, expect, it } from "vitest";
import { pythonHoverCode } from "../src/vscodeHover.js";

describe("Python hover presentation", () => {
  it("renders result shapes as Python class declarations", () => {
    expect(pythonHoverCode('PrintResult { kind: "print"; text: string; label?: string }')).toBe(
      'class PrintResult:\n    kind: "print"\n    text: str\n    label: str | None'
    );
  });

  it("renders callable summaries as Python declarations", () => {
    expect(pythonHoverCode("agent(input: str) -> AgentResult")).toBe(
      "def agent(input: str) -> AgentResult:\n    ..."
    );
  });
});
