import { describe, expect, it } from "vitest";
import { outputLinkReference } from "../src/webview/outputLink.js";

describe("output Markdown links", () => {
  it("turns workspace-relative Markdown links into editor references", () => {
    expect(outputLinkReference("archive/bep/verify/ConfigRule.py"))
      .toBe("archive/bep/verify/ConfigRule.py");
    expect(outputLinkReference("./archive/bep/verify/test%20ConfigRule.py#L4,1-L8,1"))
      .toBe("archive/bep/verify/test ConfigRule.py#L4,1-L8,1");
  });

  it("leaves external, fragment-only, and traversal links alone", () => {
    expect(outputLinkReference("https://example.com/file.py")).toBeUndefined();
    expect(outputLinkReference("#details")).toBeUndefined();
    expect(outputLinkReference("../outside.py")).toBeUndefined();
  });

  it("lets the host validate standard file URLs against the workspace", () => {
    expect(outputLinkReference("file:///C:/workspace/ConfigRule.py"))
      .toBe("file:///C:/workspace/ConfigRule.py");
  });
});
