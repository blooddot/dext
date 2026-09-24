import { describe, expect, it } from "vitest";
import { codexErrorMessage } from "../src/core/codexError.js";

describe("Codex error diagnostics", () => {
  it("keeps message-only errors concise when optional details are absent", () => {
    expect(codexErrorMessage({ message: "Unavailable", codexErrorInfo: null, additionalDetails: null }, "Failed")).toBe("Unavailable");
  });
  it("retains diagnostics even when the provider omits the message", () => {
    const message = codexErrorMessage({ codexErrorInfo: "UsageLimitExceeded", additionalDetails: { resetAt: "later" } }, "Codex turn failed.");
    expect(message).toContain("Codex turn failed.\n\nCodex error details:");
    expect(message).toContain('"UsageLimitExceeded"');
    expect(message).toContain('"resetAt": "later"');
  });
  it.each([null, undefined, [], "invalid"])("uses the fallback for an invalid error payload (%s)", (value) => {
    expect(codexErrorMessage(value, "Codex turn failed.")).toBe("Codex turn failed.");
  });
});
