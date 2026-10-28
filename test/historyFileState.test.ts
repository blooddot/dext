import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryFileState, openFileHistoryStore } from "../src/features/conversations/host/historyFileState.js";
import type { AgentStreamEvent } from "../src/shared/contracts/types.js";

class Memento {
  readonly values = new Map<string, unknown>();
  readonly writes: Array<[string, unknown]> = [];
  keys(): string[] { return [...this.values.keys()]; }
  get<T>(key: string, fallback?: T): T { return (this.values.has(key) ? this.values.get(key) : fallback) as T; }
  async update(key: string, value: unknown): Promise<void> {
    this.writes.push([key, value]);
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

const temporary: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dext-history-files-")); temporary.push(path); return path;
}
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

function session(id: string, process: AgentStreamEvent[] = []) {
  return { id, createdAt: 1, updatedAt: 2, providerSessions: { pi: "native-thread" }, turns: [
    { id: "turn", createdAt: 1, input: "original input", output: "original output", process }
  ] };
}

describe("file history storage", () => {
  it("backs up raw history, compacts interleaved snapshots and retires all Memento history keys", async () => {
    const legacy = new Memento();
    const process: AgentStreamEvent[] = [];
    let text = "";
    for (let index = 0; index < 1000; index++) {
      text += "中文";
      process.push({ phase: "reasoning", id: "r", text, replace: true });
      process.push({ phase: "status", text: "", usage: { outputTokens: index } });
    }
    const original = session("old", process);
    legacy.values.set("dext.history", [original]);
    legacy.values.set("dext.conversationLayout", { activeConversationId: "old" });
    const path = await directory();
    const store = await openFileHistoryStore(path, legacy);
    expect(store.list()[0]).toMatchObject({ providerSessions: { pi: "native-thread" }, turns: [
      { input: "original input", output: "original output", process: [
        { phase: "reasoning", text }, { phase: "status", usage: { outputTokens: 999 } }
      ] }
    ] });
    expect(legacy.keys()).toEqual(["dext.conversationLayout"]);
    expect(legacy.writes).toEqual([["dext.history", undefined]]);
    const backupNames = await readdir(join(path, "legacy-backup"));
    expect(JSON.parse(await readFile(join(path, "legacy-backup", backupNames[0]!), "utf8"))).toEqual({ key: "dext.history", value: [original] });
    const disk = await HistoryFileState.open(path);
    const diskSize = JSON.stringify(disk.get("dext.history.session:old", {})).length;
    expect(diskSize).toBeLessThan(JSON.stringify(original).length / 100);
    await store.addSuccess("new input", [], { kind: "workflow", executions: [] }, "old");
    expect(legacy.writes).toHaveLength(1);
    const reopened = await openFileHistoryStore(path, legacy);
    expect(reopened.list()[0]?.turns.map((turn) => turn.input)).toEqual(["original input", "new input"]);
  });

  it("recovers unindexed session keys from an interrupted old migration and prefers their newer state", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("same"), session("second")]);
    legacy.values.set("dext.history.session:same", { ...session("same"), archivedAt: 3 });
    legacy.values.set("dext.history.session:orphan", session("orphan"));
    const store = await openFileHistoryStore(await directory(), legacy);
    expect(store.list(true).map((value) => value.id)).toEqual(["same", "second", "orphan"]);
    expect(store.list(true)[0]?.archivedAt).toBe(3);
    expect(legacy.keys()).toEqual([]);
  });

  it("recovers a session file committed just before an interrupted index write", async () => {
    const path = await directory();
    const disk = await HistoryFileState.open(path);
    await disk.update("dext.history.session:unindexed", session("unindexed"));
    const legacy = new Memento();
    const store = await openFileHistoryStore(path, legacy);
    expect(store.list().map((session) => session.id)).toEqual(["unindexed"]);
    await store.remove("unindexed");
    expect((await openFileHistoryStore(path, legacy)).list()).toEqual([]);
  });

  it("does not resurrect old turns if cleanup fails after the disk import commits", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("old")]);
    const path = await directory();
    const update = legacy.update.bind(legacy);
    legacy.update = async () => { throw new Error("cleanup failed"); };
    await expect(openFileHistoryStore(path, legacy)).rejects.toThrow("cleanup failed");
    const disk = await HistoryFileState.open(path);
    await disk.update("dext.history.session:old", undefined);
    await disk.update("dext.history.order", []);
    legacy.update = update;
    expect((await openFileHistoryStore(path, legacy)).list()).toEqual([]);
    expect(legacy.keys()).toEqual([]);
  });

  it("keeps the source intact when disk storage cannot open, and surfaces corrupt files", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("old")]);
    const path = await directory();
    const blocked = join(path, "blocked");
    await writeFile(blocked, "file");
    await expect(openFileHistoryStore(blocked, legacy)).rejects.toThrow();
    expect(legacy.writes).toEqual([]);
    const disk = await HistoryFileState.open(path);
    await disk.update("dext.history.order", ["old"]);
    const name = (await readdir(path)).find((name) => name.endsWith(".json"))!;
    await writeFile(join(path, name), "corrupt");
    await expect(openFileHistoryStore(path, legacy)).rejects.toThrow();
    expect(legacy.writes).toEqual([]);
  });
});
