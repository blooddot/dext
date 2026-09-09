import { describe, expect, it } from "vitest";
import { CompletionMemory, CompletionMemoryEpochs, type CompletionMemoryStore } from "../src/core/completionMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { fingerprint } from "../src/core/completionContext.js";
function store() {
  const data = new Map<string, unknown>();
  const storage: CompletionMemoryStore = { get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    update: (key, value) => { if (value === undefined) data.delete(key); else data.set(key, structuredClone(value)); return Promise.resolve(); } };
  return { data, storage };
}
describe("project memory", () => {
  it("stops reading immediately during a slow clear and retries a failed clear", async () => {
    const { storage } = store(); const key = fingerprint("counter");
    let epoch = "before"; let release: () => void = () => undefined;
    const epochs = { current: () => epoch, prepare: async () => undefined,
      clear: vi.fn(() => new Promise<string>((resolve) => { release = () => { epoch = "after"; resolve(epoch); }; })) };
    const memory = new CompletionMemory(storage, "workspace", () => 1000, epochs);
    memory.record("root", key, "retained"); await memory.flush();
    const clearing = memory.clear("root"); expect(memory.clear("root")).toBe(clearing);
    expect(memory.bucket("root", key).retained).toBe(0);
    memory.record("root", key, "retained"); expect(memory.bucket("root", key).retained).toBe(0);
    release(); await clearing;
    memory.record("root", key, "retained"); expect(memory.bucket("root", key).retained).toBe(1);
    epochs.clear.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(memory.clear("root")).rejects.toThrow("disk unavailable");
    expect(memory.bucket("root", key).retained).toBe(0);
    const retry = memory.clear("root"); release(); await retry;
    memory.record("root", key, "retained"); expect(memory.bucket("root", key).retained).toBe(1); memory.dispose();
  });
  it("retries a transient write failure without needing another user acceptance", async () => {
    const { storage } = store(); const update = storage.update.bind(storage); let fail = true;
    storage.update = (key, value) => fail ? Promise.reject(new Error("busy")) : update(key, value);
    const key = fingerprint("model"); const memory = new CompletionMemory(storage, "workspace", () => 1000);
    memory.record("root", key, "retained"); await memory.flush(); fail = false; await memory.flush();
    const restored = new CompletionMemory(storage, "workspace", () => 1000);
    expect(restored.bucket("root", key).retained).toBe(1); memory.dispose(); restored.dispose();
  });
  it("rejects nonfinite or future stored timestamps and unknown bucket fields", async () => {
    const { storage, data } = store(); const key = fingerprint("model");
    const memory = new CompletionMemory(storage, "workspace", () => 1000);
    memory.record("root", key, "retained"); await memory.flush(); memory.dispose();
    const [slot, value] = [...data.entries()][0]!;
    for (const updated of [NaN, Infinity, 2000]) {
      data.set(slot, { ...(value as object), updated });
      const restored = new CompletionMemory(storage, "workspace", () => 1000);
      expect(restored.bucket("root", key).retained).toBe(0); restored.dispose();
    }
    data.set(slot, { ...(value as object), buckets: { [key]: { retained: 1, undone: 0, modified: 0, updated: Infinity } } });
    const restored = new CompletionMemory(storage, "workspace", () => 1000);
    expect(restored.bucket("root", key).retained).toBe(0); restored.dispose();
  });
  it("bounds persisted slots across repeated extension restarts", async () => {
    const { data, storage } = store(); const key = fingerprint("counter");
    for (let i = 0; i < 40; i++) {
      const memory = new CompletionMemory(storage, "workspace", () => 1000);
      memory.record("a", key, "retained"); await memory.flush(); memory.dispose();
    }
    const restored = new CompletionMemory(storage, "workspace", () => 1000);
    expect(restored.bucket("a", key).retained).toBe(40);
    expect(data.size).toBeLessThanOrEqual(8); restored.dispose();
  });
  it("does not resurrect cleared records when a stale window rewrites the entire Memento", async () => {
    const { data, storage } = store(); let epoch = "original";
    const epochs = { current: () => epoch, prepare: async () => undefined, clear: async () => { epoch = "cleared"; return epoch; } };
    const key = fingerprint("model"); const now = () => 1000;
    const memory = new CompletionMemory(storage, "workspace", now, epochs);
    memory.record("a", key, "retained"); await memory.flush();
    const staleWholeMemento = structuredClone(data);
    await memory.clear("a");
    data.clear(); for (const [key, value] of staleWholeMemento) data.set(key, value);
    const fresh = new CompletionMemory(storage, "workspace", now, epochs);
    expect(fresh.bucket("a", key).retained).toBe(0);
    expect(memory.bucket("a", key).retained).toBe(0); memory.dispose(); fresh.dispose();
  });
  it("shares clear generations across independent filesystem watchers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-memory-test-"));
    if (!directory.startsWith(join(tmpdir(), "dext-memory-test-"))) throw new Error("Invalid cleanup directory.");
    const first = new CompletionMemoryEpochs(directory); const second = new CompletionMemoryEpochs(directory);
    try {
      await vi.waitFor(async () => { await first.prepare("root"); expect(first.current("root")).toBeDefined(); });
      await second.prepare("root"); const before = second.current("root");
      expect(before).toBe(first.current("root")); await first.clear("root");
      await vi.waitFor(async () => { await second.prepare("root"); expect(second.current("root")).toBeDefined(); expect(second.current("root")).not.toBe(before); });
    } finally {
      first.dispose(); second.dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("persists invalid-reference tombstones without copying source code", async () => {
    const { storage } = store(); const now = () => 1000; const example = { path: "src/a.ts", offset: 0, length: 8, hash: fingerprint("userName"), updated: now() };
    const old = new CompletionMemory(storage, "workspace", now); old.addExample("a", example); await old.flush(); old.dispose();
    const next = new CompletionMemory(storage, "workspace", now); next.removeExample("a", example); await next.flush(); next.dispose();
    const restored = new CompletionMemory(storage, "workspace", now); expect(restored.examples("a")).toEqual([]); restored.dispose();
  });
  it("restores counters across instances, isolates roots and stores only valid references", async () => {
    const { data, storage } = store(); const now = () => 1_000_000; const key = fingerprint("account:model:ts");
    const first = new CompletionMemory(storage, "workspace", now);
    first.record("a", key, "retained"); first.record("a", key, "unknown");
    first.addExample("a", { path: "src/a.ts", offset: 0, length: 8, hash: fingerprint("userName"), updated: now() });
    first.addExample("a", { path: "../secret", offset: 0, length: 8, hash: fingerprint("bad"), updated: now() });
    await first.flush(); first.dispose();
    const next = new CompletionMemory(storage, "workspace", now);
    expect(next.bucket("a", key).retained).toBe(1); expect(next.bucket("b", key).retained).toBe(0);
    expect(next.examples("a").map((e) => e.path)).toEqual(["src/a.ts"]);
    expect(JSON.stringify([...data.values()])).not.toContain("userName"); next.dispose();
  });
  it("clear invalidates another window's dirty pre-clear snapshot", async () => {
    const { storage } = store(); const key = fingerprint("counter");
    const first = new CompletionMemory(storage); const second = new CompletionMemory(storage);
    first.record("a", key, "retained"); await first.flush();
    second.record("a", key, "retained"); await first.clear("a"); await second.flush();
    expect(first.bucket("a", key).retained).toBe(0); expect(second.bucket("a", key).retained).toBe(0);
    first.dispose(); second.dispose();
  });
  it("decays statistics, expires references and stops learning in off mode", () => {
    let now = 1000; const memory = new CompletionMemory(undefined, "session", () => now); const key = fingerprint("key");
    memory.record("a", key, "retained"); now += 7 * 86400_000; expect(memory.bucket("a", key).retained).toBeCloseTo(0.5);
    now += 30 * 86400_000; expect(memory.bucket("a", key).retained).toBe(0);
    memory.setMode("off"); memory.record("a", key, "retained"); expect(memory.bucket("a", key).retained).toBe(0); memory.dispose();
  });
  it("tolerates corrupt storage and asynchronous write failure", async () => {
    const storage: CompletionMemoryStore = { get: <T>() => "corrupt" as T, update: () => Promise.reject(new Error("disk full")) };
    const memory = new CompletionMemory(storage, "workspace", () => 1000); const key = fingerprint("key");
    memory.record("a", key, "retained"); expect(memory.bucket("a", key).retained).toBe(1);
    await memory.flush(); expect(memory.report().storageFailure).toBe(true); memory.dispose();
  });
});
