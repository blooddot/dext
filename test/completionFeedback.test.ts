import { describe, expect, it } from "vitest";
import { CompletionFeedback, type AcceptedCompletion } from "../src/core/completionFeedback.js";
import type { FeedbackKind } from "../src/core/completionMemory.js";

const entry: AcceptedCompletion = { id: "one", uri: "file:///repo/a.ts", root: "file:///repo", scope: "account-a", key: "key", offset: 5, text: "userName", original: "usName", acceptedAt: 0 };
describe("reliable completion feedback", () => {
  it("deduplicates acceptance and only learns retained, saved code after the window", () => {
    let now = 0; const results: FeedbackKind[] = [];
    const feedback = new CompletionFeedback((_entry, kind) => { results.push(kind); }, () => now);
    feedback.accept(entry); feedback.accept(entry);
    now = 29_999; feedback.mature(() => ({ text: entry.text, saved: true })); expect(results).toEqual([]);
    now++; feedback.mature(() => ({ text: entry.text, saved: true })); expect(results).toEqual(["retained"]);
    feedback.accept(entry); now += 40_000; feedback.mature(() => ({ text: entry.text, saved: true })); expect(results).toHaveLength(1);
  });
  it("tracks preceding edits and suppresses only a reliably associated undo", () => {
    let now = 0; const results: FeedbackKind[] = [];
    const feedback = new CompletionFeedback((_entry, kind) => { results.push(kind); }, () => now);
    feedback.accept(entry); feedback.change(entry.uri, [{ offset: 0, length: 0, text: "xx" }], false);
    feedback.change(entry.uri, [{ offset: 7, length: entry.text.length, text: entry.original }], true);
    expect(results).toEqual(["undone"]);
    expect(feedback.isSuppressed(entry.scope, entry.uri, 7, entry.text)).toBe(true);
    expect(feedback.isSuppressed("account-b", entry.uri, 7, entry.text)).toBe(false);
    now = 60_001; expect(feedback.isSuppressed(entry.scope, entry.uri, 7, entry.text)).toBe(false);
  });
  it("keeps closed, unsaved and ambiguous undo outcomes unknown; local rewrite is modified", () => {
    let now = 0; const results: FeedbackKind[] = [];
    const feedback = new CompletionFeedback((_entry, kind) => { results.push(kind); }, () => now);
    feedback.accept(entry); feedback.close(entry.uri);
    feedback.accept({ ...entry, id: "two" }); now = 30_000; feedback.mature(() => ({ text: entry.text, saved: false }));
    feedback.accept({ ...entry, id: "three" }); feedback.change(entry.uri, [{ offset: 6, length: 2, text: "other" }], true);
    feedback.accept({ ...entry, id: "four" }); feedback.change(entry.uri, [{ offset: 6, length: 2, text: "other" }], false);
    expect(results).toEqual(["unknown", "unknown", "unknown", "modified"]);
  });
});
