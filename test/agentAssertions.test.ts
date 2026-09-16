import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluate, MAX_SOFT_DIFF_LINES, type AgentAssertionSnapshot } from "../src/core/agentAssertions.js";
import type { PatchChange } from "../src/core/types.js";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function agentResult(change: Omit<PatchChange, "before" | "after"> & { before: string; after: string }): unknown {
  return { kind: "agent", text: "done", patch: { kind: "patch", title: "Edit", changes: [change] } };
}

interface SnapshotOptions {
  apply?: boolean;
  contents?: Record<string, string>;
  ignored?: readonly string[];
  resolve?: (uri: string) => string | undefined;
}

function snapshot(options: SnapshotOptions = {}): AgentAssertionSnapshot {
  const contents = options.contents ?? {};
  return {
    apply: options.apply ?? false,
    resolve: options.resolve ?? ((uri) => uri.startsWith("file:///workspace/") ? uri.slice("file:///workspace/".length) : undefined),
    read: (path) => contents[path],
    isIgnored: (path) => (options.ignored ?? []).includes(path)
  };
}

describe("evaluate", () => {
  it("hard-fails a URI outside the workspace on preview runs", async () => {
    const report = await evaluate(agentResult({ uri: "file:///elsewhere/a.ts", before: "old", after: "new" }), snapshot());
    expect(report.hard).toHaveLength(1);
    expect(report.hard[0]).toContain("outside the current workspace");
  });

  it("hard-fails ignored workspace paths on preview runs", async () => {
    const report = await evaluate(
      agentResult({ uri: "file:///workspace/src/a.ts", before: "old", after: "new" }),
      snapshot({ ignored: ["src/a.ts"] })
    );
    expect(report.hard[0]).toContain("ignored by the workspace ignore rules");
  });

  it("hard-fails when before no longer matches the snapshot", async () => {
    const report = await evaluate(
      agentResult({ uri: "file:///workspace/src/a.ts", before: "stale", after: "new" }),
      snapshot({ contents: { "src/a.ts": "current" } })
    );
    expect(report.hard[0]).toContain("changed after the edit preview");
  });

  it("hard-fails a stale contentHash even when before matches", async () => {
    const report = await evaluate(
      agentResult({ uri: "file:///workspace/src/a.ts", before: "current", after: "new", contentHash: hash("other") }),
      snapshot({ contents: { "src/a.ts": "current" } })
    );
    expect(report.hard[0]).toContain("no longer matches the edit preview");
  });

  it("accepts a matching before and contentHash", async () => {
    const content = "line one\nline two\n";
    const report = await evaluate(
      agentResult({ uri: "file:///workspace/src/a.ts", before: content, after: `${content}line three\n`, contentHash: hash(content) }),
      snapshot({ contents: { "src/a.ts": content } })
    );
    expect(report).toEqual({ hard: [], soft: [] });
  });

  it("checks only the patched range when the change carries one", async () => {
    const content = "before\nold line\nafter\n";
    const report = await evaluate(
      agentResult({
        uri: "file:///workspace/src/a.ts",
        before: "old line",
        after: "new line",
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }
      }),
      snapshot({ contents: { "src/a.ts": content } })
    );
    expect(report).toEqual({ hard: [], soft: [] });
  });

  it("skips hard workspace checks on apply runs", async () => {
    const report = await evaluate(
      agentResult({ uri: "file:///elsewhere/a.ts", before: "old", after: "new" }),
      snapshot({ apply: true })
    );
    expect(report.hard).toEqual([]);
  });

  it("suggests removing an empty change", async () => {
    const report = await evaluate(
      agentResult({ uri: "file:///workspace/src/a.ts", before: "same", after: "same" }),
      snapshot({ contents: { "src/a.ts": "same" } })
    );
    expect(report.soft[0]).toContain("has no effect");
  });

  it("suggests a minimal edit when a whole file was rewritten", async () => {
    const before = Array.from({ length: MAX_SOFT_DIFF_LINES + 10 }, (_, index) => `line ${index}`).join("\n");
    const after = Array.from({ length: MAX_SOFT_DIFF_LINES + 10 }, (_, index) => `changed ${index}`).join("\n");
    const report = await evaluate(
      agentResult({ uri: "file:///workspace/src/a.ts", before, after }),
      snapshot({ contents: { "src/a.ts": before } })
    );
    expect(report.soft[0]).toContain("change only the necessary lines");
  });

  it("ignores results without a patch", async () => {
    const report = await evaluate({ kind: "agent", text: "done" }, snapshot());
    expect(report).toEqual({ hard: [], soft: [] });
  });
});
