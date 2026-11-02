import { describe, expect, it } from "vitest";
import { terminalSegments } from "../src/features/conversations/presentation/terminalText.js";

const esc = String.fromCharCode(27);
const sgr = (codes: string): string => `${esc}[${codes}m`;

describe("terminalSegments", () => {
  it("colors a foreground run and returns to plain text after a reset", () => {
    const segments = terminalSegments(`${sgr("31")}red${sgr("0")}plain`);
    expect(segments.map((segment) => [segment.text, segment.classes])).toEqual([
      ["red", ["ansi-red"]],
      ["plain", []]
    ]);
  });

  it("adds bold and removes it again with 22", () => {
    const segments = terminalSegments(`${sgr("1")}bold${sgr("22")}plain`);
    expect(segments.map((segment) => [segment.text, segment.classes])).toEqual([
      ["bold", ["ansi-bold"]],
      ["plain", []]
    ]);
  });

  it("resolves an indexed 256 color and clears it with 39", () => {
    const segments = terminalSegments(`${sgr("38;5;196")}hot${sgr("39")}plain`);
    expect(segments[0]?.color).toBe("rgb(255, 0, 0)");
    expect(segments[1]?.text).toBe("plain");
    expect(segments[1]?.color).toBeUndefined();
  });

  it("resolves a 24-bit foreground color", () => {
    expect(terminalSegments(`${sgr("38;2;10;20;30")}x`)[0]?.color).toBe("rgb(10, 20, 30)");
  });

  it("falls back to line emphasis when the output carries no ANSI", () => {
    const segments = terminalSegments("error: failed\ndone");
    expect(segments.map((segment) => [segment.text, segment.classes])).toEqual([
      ["error: failed", ["ansi-red"]],
      ["\n", []],
      ["done", []]
    ]);
  });

  it("keeps only the rewritten part of a carriage-return line", () => {
    const segments = terminalSegments(`before\r${sgr("31")}red\nnext`);
    expect(segments.map((segment) => segment.text).join("")).toBe("red\nnext");
    expect(segments[0]?.classes).toEqual(["ansi-red"]);
  });

  it("ignores background and reverse-video codes", () => {
    const segments = terminalSegments(`${sgr("41")}a${sgr("48;5;196")}b${sgr("48;2;1;2;3")}c${sgr("7")}d`);
    expect(segments.map((segment) => segment.text).join("")).toBe("abcd");
    expect(segments.every((segment) => segment.classes.length === 0 && segment.color === undefined)).toBe(true);
  });
});
