import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  agentResultCandidates,
  formatDiagnostics,
  jsonCandidates,
  parseAgentResult,
  safeValidate
} from "../src/core/resultBoundary.js";

const agent = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: "agent", text, ...extra });

describe("jsonCandidates", () => {
  it("finds narration, fenced JSON, and trailing commentary", () => {
    const raw = [
      "Here is the result you asked for:",
      "```json",
      agent("first"),
      "```",
      "Let me know if you need anything else."
    ].join("\n");
    const candidates = jsonCandidates(raw);
    expect(candidates).toContain(agent("first"));
    expect(candidates).toContain(raw.trim());
  });

  it("starts a balanced-object scan at every opening brace, not just the first", () => {
    const raw = '{"nested":{"value":1}} and later {"kind":"agent","text":"second"}';
    const candidates = jsonCandidates(raw);
    expect(candidates).toContain('{"nested":{"value":1}}');
    expect(candidates).toContain('{"kind":"agent","text":"second"}');
  });

  it("understands braces and escaped quotes inside JSON strings", () => {
    const raw = `prefix ${agent('braces { and } plus "quotes"')} suffix`;
    const candidates = jsonCandidates(raw);
    const parsed = candidates.map((candidate) => { try { return JSON.parse(candidate) as unknown; } catch { return undefined; } });
    expect(parsed).toContainEqual({ kind: "agent", text: 'braces { and } plus "quotes"' });
  });

  it("keeps a truncated object out of the candidate list", () => {
    const raw = 'answer: {"kind":"agent","text":"cut off"';
    const parsed = agentResultCandidates(raw);
    expect(parsed).toEqual([]);
  });
});

describe("parseAgentResult", () => {
  it("unwraps narration, a json fence, and trailing commentary", () => {
    const raw = [
      "I inspected the workspace first.",
      "```json",
      agent("final", { summary: "done" }),
      "```",
      "That is everything."
    ].join("\n");
    expect(parseAgentResult("agent", raw)).toEqual({ kind: "agent", text: "final", summary: "done" });
  });

  it("prefers a kind-matching candidate over an earlier unrelated object", () => {
    const raw = 'config: {"value":1} then the answer: {"kind":"ask","text":"question"} then {"kind":"agent","text":"answer"}';
    expect(parseAgentResult("agent", raw)).toMatchObject({ kind: "agent", text: "answer" });
  });

  it("uses the last candidate when several carry the same kind", () => {
    const raw = `${agent("first")} noise ${agent("last")}`;
    const onDiagnostic = vi.fn();
    expect(parseAgentResult("agent", raw, { onDiagnostic })).toEqual({ kind: "agent", text: "last" });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for text without a recoverable object", () => {
    expect(parseAgentResult("agent", "plain text")).toBeUndefined();
    expect(parseAgentResult("agent", '{"kind":"agent","text":"truncated"')).toBeUndefined();
  });

  it("passes already-parsed objects through unchanged", () => {
    const value = { kind: "agent", text: "raw" };
    expect(parseAgentResult("agent", value)).toBe(value);
  });
});

describe("formatDiagnostics", () => {
  it("renders zod issues as path: message", () => {
    const parsed = z.object({ name: z.string(), nested: z.object({ count: z.number() }) }).safeParse({ name: 1, nested: { count: "x" } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const text = formatDiagnostics(parsed.error);
    expect(text).toContain("name: ");
    expect(text).toContain("nested.count: ");
  });

  it("truncates the number of issues and the total length", () => {
    const schema = z.object(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, z.string()])));
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const lines = formatDiagnostics(parsed.error).split("\n");
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(lines.at(-1)).toMatch(/more issue/);
    expect(formatDiagnostics(parsed.error).length).toBeLessThanOrEqual(403);
  });

  it("falls back to the error message without zod issues", () => {
    expect(formatDiagnostics(new Error("plain failure"))).toBe("plain failure");
  });
});

describe("safeValidate", () => {
  it("returns data on success and diagnostics on failure", () => {
    const schema = z.object({ value: z.number() });
    const good = safeValidate(schema, { value: 1 });
    expect(good).toEqual({ success: true, data: { value: 1 } });
    const bad = safeValidate(schema, { value: "no" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.diagnostics).toContain("value: ");
  });
});
