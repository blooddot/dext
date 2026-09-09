import { describe, expect, it } from "vitest";
import { completionCandidate } from "../src/core/completionCandidate.js";
function apply(prefix: string, suffix: string, reply: string) {
  const candidate = completionCandidate(reply, { prefix, suffix });
  if (!candidate) return undefined;
  return prefix.slice(0, prefix.length - candidate.replaceBefore) + candidate.text + suffix.slice(candidate.replaceAfter);
}
describe("candidate edits", () => {
  it("replaces existing identifier tails without duplicating them", () => {
    expect(apply("const x = us", "Name;", "erName")).toBe("const x = userName;");
    expect(apply("const x = user", ";", "userName")).toBe("const x = userName;");
  });
  it("keeps multi-line insertion and filters commentary and prompt tags", () => {
    expect(apply("function f() {", "", "\n  return 1;\n}")).toBe("function f() {\n  return 1;\n}");
    expect(apply("a", "", "Here is the code")).toBeUndefined();
    expect(apply("a", "", "x</after_cursor>")).toBeUndefined();
  });
});
