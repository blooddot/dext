import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piSessionCwd } from "../src/features/agents/host/piSessionHeader.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))); });
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dext-pi-header-")); roots.push(root); return root;
}
const header = (fields: Record<string, unknown>): string => `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", ...fields })}\n`;
describe("Pi session header", () => {
  it("returns the recorded workspace without reading the rest of the session", async () => {
    const root = await temporary(), path = join(root, "session.jsonl");
    await writeFile(path, `${header({ cwd: root })}${JSON.stringify({ type: "message", content: "a".repeat(200_000) })}\n`);
    expect(await piSessionCwd(path)).toBe(root);
  });
  it("returns the recorded workspace even when it later moved or became a file", async () => {
    // The existence and directory checks belong to the caller, so the header is
    // reported as written; a stale value must not be mistaken for "no header".
    const root = await temporary(), file = join(root, "workspace.txt"), missing = join(root, "renamed-away");
    await writeFile(file, "not a directory");
    const asFile = join(root, "as-file.jsonl"), asMissing = join(root, "as-missing.jsonl");
    await writeFile(asFile, header({ cwd: file })); await writeFile(asMissing, header({ cwd: missing }));
    expect(await piSessionCwd(asFile)).toBe(file);
    expect(await piSessionCwd(asMissing)).toBe(missing);
  });
  it("returns undefined for a first line that is not a session header", async () => {
    const root = await temporary(), path = join(root, "session.jsonl");
    await writeFile(path, "{ broken json\n");
    expect(await piSessionCwd(path)).toBeUndefined();
    await writeFile(path, "[]\n"); expect(await piSessionCwd(path)).toBeUndefined();
  });
  it("returns undefined when the header has no usable workspace", async () => {
    const root = await temporary(), path = join(root, "session.jsonl");
    await writeFile(path, header({})); expect(await piSessionCwd(path)).toBeUndefined();
    await writeFile(path, header({ cwd: "" })); expect(await piSessionCwd(path)).toBeUndefined();
    await writeFile(path, header({ cwd: "   " })); expect(await piSessionCwd(path)).toBeUndefined();
    await writeFile(path, header({ cwd: 42 })); expect(await piSessionCwd(path)).toBeUndefined();
  });
  it("returns undefined for an unreadable session file", async () => {
    const root = await temporary();
    expect(await piSessionCwd(join(root, "absent.jsonl"))).toBeUndefined();
    expect(await piSessionCwd(root)).toBeUndefined();
  });
  it("returns undefined when the first line exceeds the header limit", async () => {
    const root = await temporary(), path = join(root, "session.jsonl");
    await writeFile(path, `{"type":"session","cwd":"${"a".repeat(70 * 1024)}"`);
    expect(await piSessionCwd(path)).toBeUndefined();
  });
  it("accepts a header without a trailing newline", async () => {
    const root = await temporary(), path = join(root, "session.jsonl");
    await writeFile(path, JSON.stringify({ type: "session", cwd: root }));
    expect(await piSessionCwd(path)).toBe(root);
  });
});
