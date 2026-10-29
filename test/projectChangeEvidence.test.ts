import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ProjectChangeEvidence } from "../src/features/project/host/projectChangeEvidence.js";

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
async function fixture(git = true) {
  const directory = await mkdtemp(join(tmpdir(), "dext-plan-evidence-")); temporary.push(directory);
  const root = join(directory, "repo"); await mkdir(root);
  if (git) execFileSync("git", ["init", "--quiet", root]);
  return { root, evidence: new ProjectChangeEvidence(root, join(directory, "storage")), git: (...args: string[]) => execFileSync("git", ["-c", "user.name=Dext Test", "-c", "user.email=dext@example.invalid", ...args], { cwd: root }) };
}
describe("Plan content evidence", { timeout: 20_000 }, () => {
  it("excludes pre-existing dirty edits and observes changes even when committed during execution", async () => {
    const f = await fixture(); await writeFile(join(f.root, "a.ts"), "original"); f.git("add", "."); f.git("commit", "-qm", "initial");
    await writeFile(join(f.root, "a.ts"), "user dirty edit"); await writeFile(join(f.root, "untracked.ts"), "preexisting");
    const baseline = await f.evidence.capture();
    expect((await f.evidence.compare(baseline.id)).changes).toEqual([]);
    await writeFile(join(f.root, "a.ts"), "new code"); f.git("add", "."); f.git("commit", "-qm", "during execution");
    const report = await f.evidence.compare(baseline.id);
    expect(report.complete).toBe(true);
    expect(report.changes).toEqual([{ path: "a.ts", kind: "modified", before: "user dirty edit", after: "new code", beforeHash: expect.any(String), afterHash: expect.any(String) }]);
  });
  it("reports additions, deletion and rename candidates without asserting authorship", async () => {
    const f = await fixture(); await writeFile(join(f.root, "old.ts"), "same bytes");
    const baseline = await f.evidence.capture(); await rename(join(f.root, "old.ts"), join(f.root, "new.ts"));
    const report = await f.evidence.compare(baseline.id);
    expect(report.renameCandidates).toEqual([{ from: "old.ts", to: "new.ts" }]);
    expect(report.changes.map(change => change.kind)).toEqual(["added", "deleted"]);
  });
  it("keeps no-Git, binary and budget limitations explicit", async () => {
    const f = await fixture(false); await writeFile(join(f.root, "blob"), Buffer.from([0, 1, 2]));
    await writeFile(join(f.root, "large"), "x".repeat(300_000));
    const baseline = await f.evidence.capture();
    expect(baseline.complete).toBe(false); expect(baseline.diagnostics.join(" ")).toMatch(/Git.*budget/i);
    await expect(f.evidence.compare("../escape")).rejects.toThrow("identity");
    await expect(f.evidence.compare("00000000-0000-4000-8000-000000000000")).rejects.toThrow();
  });
  it("does not let unchanged binary assets block text changes but diagnoses binary edits", async () => {
    const f = await fixture(); await writeFile(join(f.root, "logo.png"), Buffer.from([0, 1, 2]));
    const baseline = await f.evidence.capture();
    expect((await f.evidence.compare(baseline.id)).complete).toBe(true);
    await writeFile(join(f.root, "logo.png"), Buffer.from([0, 1, 3]));
    const report = await f.evidence.compare(baseline.id);
    expect(report.complete).toBe(false); expect(report.changes).toMatchObject([{ path: "logo.png", kind: "modified" }]);
    expect(report.diagnostics.join(" ")).toContain("binary");
  });
});
