import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryFiles, openFileHistoryStore } from "../src/features/conversations/host/historyFileState.js";
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

function turn(input: string) {
  return { id: `turn-${input}`, createdAt: 1, input, output: "", process: [] };
}

/** The name the old per-key Memento dump used. */
function legacyName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

function bodyName(id: string): string {
  return `${Buffer.from(id, "utf8").toString("hex")}.jsonl`;
}

async function bodyFile(path: string): Promise<string> {
  return join(path, (await readdir(path)).find((name) => name.endsWith(".jsonl"))!);
}

const workflow = { kind: "workflow" as const, executions: [] };

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
    expect((await store.sessions())[0]).toMatchObject({ providerSessions: { pi: "native-thread" }, turns: [
      { input: "original input", output: "original output", process: [
        { phase: "reasoning", text }, { phase: "status", usage: { outputTokens: 999 } }
      ] }
    ] });
    expect(legacy.keys()).toEqual(["dext.conversationLayout"]);
    expect(legacy.writes).toEqual([["dext.history", undefined]]);
    const backupNames = await readdir(join(path, "legacy-backup"));
    expect(JSON.parse(await readFile(join(path, "legacy-backup", backupNames[0]!), "utf8"))).toEqual({ key: "dext.history", value: [original] });
    // The index and one line-per-turn body replace the whole-session JSON.
    expect(await readdir(path)).toContain("index.json");
    const disk = await HistoryFiles.open(path);
    expect((await disk.read("old"))?.turns[0]?.input).toBe("original input");
    expect((await stat(await bodyFile(path))).size).toBeLessThan(JSON.stringify(original).length / 100);
    await store.addSuccess("new input", [], { kind: "workflow", executions: [] }, "old");
    expect(legacy.writes).toHaveLength(1);
    const reopened = await openFileHistoryStore(path, legacy);
    expect((await reopened.sessions())[0]?.turns.map((entry) => entry.input)).toEqual(["original input", "new input"]);
  });

  it("keeps a turn another window committed after this window loaded", async () => {
    const path = await directory();
    const first = await openFileHistoryStore(path, new Memento());
    await first.addSuccess("one", [], { kind: "workflow", executions: [] }, "shared");
    // The second window loads one-turn history before the first window commits again.
    const second = await openFileHistoryStore(path, new Memento());
    await first.addSuccess("two", [], { kind: "workflow", executions: [] }, "shared");
    // Renaming in the older window must not write its shorter copy back.
    expect(await second.renameTurn("shared", (await second.sessions())[0]!.turns[0]!.id, "renamed")).toBe(true);
    const reopened = await openFileHistoryStore(path, new Memento());
    const shared = (await reopened.sessions())[0]!;
    expect(shared.turns.map((entry) => entry.input)).toEqual(["one", "two"]);
    expect(shared.turns[0]!.title).toBe("renamed");
  });

  it("recovers unindexed session keys from an interrupted old migration and prefers their newer state", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("same"), session("second")]);
    legacy.values.set("dext.history.session:same", { ...session("same"), archivedAt: 3 });
    legacy.values.set("dext.history.session:orphan", session("orphan"));
    const store = await openFileHistoryStore(await directory(), legacy);
    const sessions = await store.sessions(true);
    expect(sessions.map((value) => value.id)).toEqual(["same", "second", "orphan"]);
    expect(sessions[0]?.archivedAt).toBe(3);
    expect(legacy.keys()).toEqual([]);
  });

  it("recovers a conversation body committed just before an interrupted index write", async () => {
    const path = await directory();
    await writeFile(join(path, bodyName("unindexed")), `${JSON.stringify(turn("kept"))}\n`);
    const legacy = new Memento();
    const store = await openFileHistoryStore(path, legacy);
    expect((await store.sessions()).map((value) => value.id)).toEqual(["unindexed"]);
    await store.remove("unindexed");
    expect(await (await openFileHistoryStore(path, legacy)).sessions()).toEqual([]);
  });

  it("rebuilds a corrupted index from the conversation bodies", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("old")]);
    const path = await directory();
    await openFileHistoryStore(path, legacy);
    await writeFile(join(path, "index.json"), "{ broken");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await (await openFileHistoryStore(path, new Memento())).sessions()).map((value) => value.id)).toEqual(["old"]);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("retires the raw import backup after a week and keeps a newer one", async () => {
    const importOnce = async (ageMs: number): Promise<string> => {
      const legacy = new Memento();
      legacy.values.set("dext.history", [session("old")]);
      const path = await directory();
      await openFileHistoryStore(path, legacy);
      const backup = join(path, "legacy-backup");
      const when = new Date(Date.now() - ageMs);
      await utimes(join(backup, (await readdir(backup))[0]!), when, when);
      const store = await openFileHistoryStore(path, legacy);
      expect((await store.sessions()).map((value) => value.id)).toEqual(["old"]);
      return backup;
    };
    await expect(readdir(await importOnce(8 * 24 * 60 * 60 * 1000))).rejects.toThrow();
    expect(await readdir(await importOnce(24 * 60 * 60 * 1000))).toHaveLength(1);
  });

  it("spills oversized text to a file and prunes only stale unreferenced ones", async () => {
    const path = await directory();
    const limits = () => ({ maxTurns: 10, maxOutputLength: 12 });
    const store = await openFileHistoryStore(path, new Memento(), limits);
    const text = `head${"=".repeat(28)}tail`;
    await store.addSuccess("short", [{ phase: "status", text }], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    const spillPath = store.spillPath("session-1", "turn-1")!;
    expect(await readFile(spillPath, "utf8")).toContain(text);

    const overflow = join(path, "overflow");
    const stale = join(overflow, "stale.txt");
    await writeFile(stale, "old");
    const when = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(stale, when, when);
    await writeFile(join(overflow, "fresh.txt"), "new");

    // Pruning reads the index, so it still knows the spill file is referenced.
    await openFileHistoryStore(path, new Memento(), limits);
    expect((await readdir(overflow)).sort()).toEqual([basename(spillPath), "fresh.txt"].sort());
  });

  it("does not resurrect old turns if cleanup fails after the disk import commits", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("old")]);
    const path = await directory();
    const update = legacy.update.bind(legacy);
    legacy.update = async () => { throw new Error("cleanup failed"); };
    await expect(openFileHistoryStore(path, legacy)).rejects.toThrow("cleanup failed");
    // The user deleted the conversation while the cleanup kept failing.
    await (await HistoryFiles.open(path)).remove("old");
    legacy.update = update;
    expect(await (await openFileHistoryStore(path, legacy)).sessions()).toEqual([]);
    expect(legacy.keys()).toEqual([]);
  });

  it("skips an unreadable or mismatched history file instead of failing activation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = await directory();
      const kept = "dext.history.session:kept";
      await writeFile(join(path, legacyName(kept)), JSON.stringify({ key: kept, value: session("kept") }));
      // Neither a damaged body nor a name that does not match its key may take
      // the whole History down: the user would lose the entry to delete it.
      await writeFile(join(path, `${"a".repeat(64)}.json`), JSON.stringify({ key: "dext.history.session:other", value: session("other") }));
      await writeFile(join(path, `${"b".repeat(64)}.json`), "corrupt");
      const skipped: string[] = [];
      const reopened = await HistoryFiles.open(path, (names) => skipped.push(...names));
      expect(reopened.summaries().map((value) => value.id)).toEqual(["kept"]);
      // Both broken files are named for the activation warning, logged too, and
      // left in place for inspection.
      expect([...skipped].sort()).toEqual(["a".repeat(64) + ".json", "b".repeat(64) + ".json"]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(await readdir(path)).toEqual(expect.arrayContaining(["a".repeat(64) + ".json", "b".repeat(64) + ".json"]));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the source intact when disk storage cannot open, and survives corrupt files", async () => {
    const legacy = new Memento();
    legacy.values.set("dext.history", [session("old")]);
    const path = await directory();
    const blocked = join(path, "blocked");
    await writeFile(blocked, "file");
    await expect(openFileHistoryStore(blocked, legacy)).rejects.toThrow();
    expect(legacy.writes).toEqual([]);
    await writeFile(join(path, `${"c".repeat(64)}.json`), "corrupt");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The damaged file is skipped, so activation still succeeds and imports.
      expect((await (await openFileHistoryStore(path, legacy)).sessions()).map((value) => value.id)).toEqual(["old"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("lists conversations from the index and does not read bodies", async () => {
    const path = await directory();
    const store = await openFileHistoryStore(path, new Memento());
    await store.addSuccess("first", [], workflow, "session-1");
    await store.addSuccess("second", [], workflow, "session-2");
    for (const name of await readdir(path)) if (name.endsWith(".jsonl")) await rm(join(path, name));
    const files = await HistoryFiles.open(path);
    expect(files.summaries().map((summary) => [summary.id, summary.turnCount, summary.firstInput]))
      .toEqual([["session-1", 1, "first"], ["session-2", 1, "second"]]);
  });

  it("appends a new turn as one more line instead of rewriting the body", async () => {
    const path = await directory();
    const store = await openFileHistoryStore(path, new Memento());
    await store.addSuccess("first", [], workflow, "session-1");
    const file = await bodyFile(path);
    const before = await readFile(file, "utf8");
    await store.addSuccess("second", [], workflow, "session-1");
    const after = await readFile(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trimEnd().split("\n")).toHaveLength(2);
  });

  it("keeps a resource document out of the index and reads it back", async () => {
    const path = await directory();
    const content = "x".repeat(200_000);
    const resource = {
      type: "skill" as const, scope: "project" as const, saved: true,
      target: { name: "archify", path: "skills/archify/SKILL.md", content, files: [{ path: "skills/archify/LICENSE", content }] }
    };
    const files = await HistoryFiles.open(path);
    await files.writeTurns({ ...session("resource"), resource });
    // One saved pack used to make every history write rewrite its contents.
    expect((await readFile(join(path, "index.json"), "utf8")).length).toBeLessThan(2_000);
    expect(files.summaries()[0]?.resource).toEqual({ type: "skill", scope: "project", saved: true,
      target: { name: "archify", path: "skills/archify/SKILL.md" } });
    expect((await files.read("resource"))?.resource).toEqual(resource);
  });

  it("moves a resource document an index still carries out to its own file", async () => {
    const path = await directory();
    const content = "y".repeat(200_000);
    const resource = { type: "rule" as const, scope: "global" as const, target: { name: "house", path: "house.md", content } };
    await writeFile(join(path, "index.json"), JSON.stringify({ imported: true, order: ["old"],
      sessions: { old: { id: "old", createdAt: 1, updatedAt: 2, turnCount: 1, resource } } }));
    await writeFile(join(path, bodyName("old")), `${JSON.stringify(turn("first"))}\n`);
    const files = await HistoryFiles.open(path);
    expect((await readFile(join(path, "index.json"), "utf8")).length).toBeLessThan(2_000);
    expect((await files.read("old"))?.resource?.target?.content).toBe(content);
  });

  it("skips a damaged turn line, keeps the rest and heals the index from the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = await directory();
      const store = await openFileHistoryStore(path, new Memento());
      await store.addSuccess("first", [], workflow, "session-1");
      await store.addSuccess("second", [], workflow, "session-1");
      const file = await bodyFile(path);
      // A crash between the append and the index write, plus a torn line.
      await writeFile(file, `${(await readFile(file, "utf8")).trimEnd()}\n${JSON.stringify(turn("third"))}\n{ torn\n`);
      const reopened = await openFileHistoryStore(path, new Memento());
      expect((await reopened.sessions())[0]?.turns.map((entry) => entry.input)).toEqual(["first", "second", "third"]);
      expect(reopened.summaries()[0]?.turnCount).toBe(3);
      expect(warn).toHaveBeenCalled();
      // The repaired count is in the index now, so the next window needs no body.
      expect((await HistoryFiles.open(path)).summaries()[0]?.turnCount).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });
});
