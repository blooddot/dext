import { describe, expect, it } from "vitest";
import { outputExternalLink, outputLinkReference } from "../src/webview/outputLink.js";

describe("output Markdown links", () => {
  it("turns workspace-relative Markdown links into editor references", () => {
    expect(outputLinkReference("archive/bep/verify/ConfigRule.py"))
      .toBe("archive/bep/verify/ConfigRule.py");
    expect(outputLinkReference("./archive/bep/verify/test%20ConfigRule.py#L4,1-L8,1"))
      .toBe("archive/bep/verify/test ConfigRule.py#L4,1-L8,1");
    expect(outputLinkReference("@.dext-global/attachments/0123456789abcdef01234567.png"))
      .toBe(".dext-global/attachments/0123456789abcdef01234567.png");
    expect(outputLinkReference("C:/github/blooddot/dext/package.json:809"))
      .toBe("C:/github/blooddot/dext/package.json:809");
    expect(outputLinkReference("C:/github/blooddot/dext/test%20file.ts:4"))
      .toBe("C:/github/blooddot/dext/test file.ts:4");
    expect(outputLinkReference("/Users/test/project/file.ts:42:3"))
      .toBe("/Users/test/project/file.ts:42:3");
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

  it("hands browser and mail links to the extension host", () => {
    expect(outputExternalLink("https://example.com/docs?q=1")).toBe("https://example.com/docs?q=1");
    expect(outputExternalLink("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(outputExternalLink("file:///C:/workspace/ConfigRule.py")).toBeUndefined();
    expect(outputExternalLink("javascript:alert(1)")).toBeUndefined();
  });
});
