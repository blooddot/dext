import { describe, expect, it } from "vitest";
import { runArchitectureScan, startArchitectureScan } from "../src/core/projectArchitectureWorker.js";

const files = [
  { path: "src/a.ts", content: "import './b';" },
  { path: "src/b.ts", content: "export const b = 1;" },
  { path: "src/c.ts", content: "export const c = 2;" }
];

describe("architecture scan worker", () => {
  it("enforces file count and size limits with explicit coverage", () => {
    const outcome = runArchitectureScan(files, { maxFiles: 2 });
    expect(outcome.result.modules).toHaveLength(2);
    expect(outcome.coverage.limitReached).toBe(true);
    expect(outcome.coverage.skippedFiles).toBe(1);
    expect(outcome.result.unsupported.some((item) => item.reason === "File limit exceeded.")).toBe(true);
  });

  it("stops at the wall-clock deadline and reports why", () => {
    const outcome = runArchitectureScan(files, { maxDurationMs: 1, now: () => 0 });
    // The deadline is already in the past once scanning starts.
    expect(outcome.coverage.limitReached).toBe(true);
    expect(outcome.result.unsupported.some((item) => item.reason === "Scan time limit exceeded.")).toBe(true);
  });

  it("cancels cooperatively and returns a partial result instead of throwing", async () => {
    const task = startArchitectureScan(files);
    task.cancel();
    const outcome = await task.promise;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.coverage.scannedFiles).toBe(0);
  });

  it("returns relations with evidence positions for a normal scan", async () => {
    const outcome = await startArchitectureScan(files).promise;
    expect(outcome.cancelled).toBe(false);
    const relation = outcome.result.relations.find((item) => item.from === "src/a" && item.to === "src/b");
    expect(relation?.file).toBe("src/a.ts");
    expect(relation?.line).toBe(1);
    expect(outcome.coverage.scannedFiles).toBe(3);
  });
});
