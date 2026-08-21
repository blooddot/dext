import { describe, expect, it, vi } from "vitest";
import { pasteEventText } from "../src/webview/codeEditor.js";

describe("editor paste events", () => {
  it("returns multi-line plain text from the browser paste event unchanged", () => {
    const text = "first line\r\nsecond line\nthird line";
    const getData = vi.fn((type: string) => type === "text/plain" ? text : "");

    expect(pasteEventText({
      clipboardData: { types: ["text/plain"], getData } as unknown as DataTransfer
    })).toBe(text);
    expect(getData).toHaveBeenCalledWith("text/plain");
  });

  it("falls back to the host clipboard when plain text is unavailable", () => {
    expect(pasteEventText({
      clipboardData: { types: [], getData: vi.fn() } as unknown as DataTransfer
    })).toBeUndefined();
  });

  it("accepts browser plain text even when the browser changes the MIME casing", () => {
    const getData = vi.fn(() => "copied response");
    expect(pasteEventText({
      clipboardData: { types: ["TEXT/PLAIN"], getData } as unknown as DataTransfer
    })).toBe("copied response");
    expect(getData).toHaveBeenCalledWith("TEXT/PLAIN");
  });
});
