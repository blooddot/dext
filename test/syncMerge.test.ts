import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { historySummaryOf, type DextHistoryRecord, type DextHistorySession } from "../src/features/conversations/contracts/history.js";
import {
  historyBodyFile,
  historyResourceFile,
  historySessionIdFromBodyFile,
  readHistoryBody,
  readHistoryIndexFile,
  writeHistoryBody,
  writeHistoryIndexFile
} from "../src/features/conversations/host/historyFileState.js";
import { mergePreferences, mergeSummary, mergeTurns } from "../src/features/sync/domain/syncMerge.js";
import { syncDirectory } from "../src/features/sync/host/directorySync.js";
import type { SyncPreferences } from "../src/features/sync/contracts/sync.js";

function turn(id: string, createdAt: number, input = id): DextHistoryRecord {
  return { id, createdAt, input, process: [], output: "" };
}

function session(id: string, turns: DextHistoryRecord[]): DextHistorySession {
  return {
    id,
    createdAt: turns[0]?.createdAt ?? 1,
    updatedAt: turns.at(-1)?.createdAt ?? 1,
    turns
  };
}

const emptyPreferences: SyncPreferences = {
  pinned: [],
  favorites: [],
  titles: {},
  layout: { openConversationIds: [] },
  selections: {},
  drafts: {}
};

const historyPort = {
  readIndex: readHistoryIndexFile,
  writeIndex: writeHistoryIndexFile,
  readBody: readHistoryBody,
  writeBody: writeHistoryBody,
  bodyFile: historyBodyFile,
  resourceFile: historyResourceFile,
  sessionIdFromBodyFile: historySessionIdFromBodyFile
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mergeTurns", () => {
  it("unions turns either machine added while apart", () => {
    const local = [turn("a", 1)];
    const remote = [turn("a", 1), turn("b", 2)];
    expect(mergeTurns(local, remote, false).map((item) => item.id)).toEqual(["a", "b"]);
    expect(mergeTurns(remote, local, true).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("lets the newer side win when it only removed a turn", () => {
    const older = [turn("a", 1), turn("b", 2)];
    const newer = [turn("a", 1)];
    expect(mergeTurns(newer, older, true).map((item) => item.id)).toEqual(["a"]);
    expect(mergeTurns(older, newer, false).map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps both sides when the newer one also added a turn", () => {
    const left = [turn("a", 1), turn("b", 2)];
    const right = [turn("a", 1), turn("c", 3)];
    expect(mergeTurns(left, right, true).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("mergeSummary", () => {
  it("takes metadata from the later write and unions provider bindings", () => {
    const older = {
      ...historySummaryOf(session("s", [turn("a", 1)])),
      providerSessions: { codex: "x" },
      archivedAt: 10
    };
    const newer = {
      ...historySummaryOf(session("s", [turn("a", 1), turn("b", 2)])),
      providerSessions: { claude: "y" }
    };
    const merged = mergeSummary(older, newer, [turn("a", 1), turn("b", 2)]);
    expect(merged.turnCount).toBe(2);
    expect(merged.firstInput).toBe("a");
    expect(merged.providerSessions).toEqual({ codex: "x", claude: "y" });
    // The newer summary has no archivedAt, so the archive was undone.
    expect(merged.archivedAt).toBeUndefined();
  });
});

describe("mergePreferences", () => {
  it("unions lists and lets the local value win for a shared title", () => {
    const local: SyncPreferences = {
      ...emptyPreferences,
      pinned: ["a"],
      titles: { s: "local" },
      layout: { openConversationIds: ["a"], activeConversationId: "a" }
    };
    const remote: SyncPreferences = {
      ...emptyPreferences,
      pinned: ["b"],
      titles: { s: "remote", t: "kept" },
      layout: { openConversationIds: ["b"], activeConversationId: "b" }
    };
    const merged = mergePreferences(local, remote);
    expect(merged.pinned).toEqual(["a", "b"]);
    expect(merged.titles).toEqual({ s: "local", t: "kept" });
    expect(merged.layout.openConversationIds).toEqual(["a", "b"]);
    expect(merged.layout.activeConversationId).toBe("a");
  });
});

describe("syncDirectory", () => {
  it("merges both sides and becomes a no-op on the second run", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-sync-"));
    roots.push(root);
    const local = join(root, "local");
    const remote = join(root, "remote");

    const localSession = session("s1", [turn("t1", 1, "office")]);
    await writeHistoryBody(local, "s1", localSession.turns);
    await writeHistoryIndexFile(local, {
      imported: true,
      order: ["s1"],
      sessions: { s1: historySummaryOf(localSession) }
    });

    const remoteSession = session("s1", [turn("t1", 1, "office"), turn("t2", 2, "home")]);
    await writeHistoryBody(join(remote, "conversation-history"), "s1", remoteSession.turns);
    await writeHistoryIndexFile(join(remote, "conversation-history"), {
      imported: true,
      order: ["s1"],
      sessions: { s1: historySummaryOf(remoteSession) }
    });

    const first = await syncDirectory({ history: historyPort, historyDir: local, syncRoot: remote });
    expect(first.pulledSessions).toBe(1);
    expect((await readHistoryBody(local, "s1"))?.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect((await readHistoryIndexFile(local))?.sessions.s1?.turnCount).toBe(2);

    const second = await syncDirectory({ history: historyPort, historyDir: local, syncRoot: remote });
    expect(second.pulledSessions).toBe(0);
    expect(second.pushedSessions).toBe(0);
  });

  it("refuses a sync folder inside the history folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-sync-"));
    roots.push(root);
    await expect(syncDirectory({
      history: historyPort,
      historyDir: join(root, "history"),
      syncRoot: join(root, "history", "nested")
    }))
      .rejects.toThrow(/outside/);
  });
});
