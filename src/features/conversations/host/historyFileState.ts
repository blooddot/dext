import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type * as vscode from "vscode";
import {
  DEFAULT_HISTORY_LIMITS, historySessionOf, historySummaryOf, legacyHistorySession,
  type DextHistoryLimits, type DextHistoryRecord, type DextHistorySession, type DextHistorySummary, type HistoryBackend
} from "../contracts/history.js";
import { compactAgentEvents } from "../domain/agentEventLog.js";
import { DextHistoryStore } from "./historyStore.js";

const HISTORY_KEY = "dext.history";
const SESSION_PREFIX = "dext.history.session:";
const ORDER_KEY = "dext.history.order";
const IMPORTED_KEY = "dext.history.imported";
const INDEX_FILE = "index.json";
const BODY_SUFFIX = ".jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_MAX_AGE_MS = 7 * DAY_MS;
const OVERFLOW_MAX_AGE_MS = DAY_MS;

function historyKey(key: string): boolean {
  return key === HISTORY_KEY || key === ORDER_KEY || key === IMPORTED_KEY || key.startsWith(SESSION_PREFIX);
}

/** `<sha>.json` files are the per-key Memento dump this store migrated from. */
function isLegacyFile(name: string): boolean {
  return /^[a-f0-9]{64}\.json$/.test(name);
}

function legacyFilePath(directory: string, key: string): string {
  return join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

/** The body file name encodes the conversation id instead of hashing it, so a
 * lost index can be rebuilt from the bodies alone. Ids are short and ASCII. */
function bodyPath(directory: string, sessionId: string): string {
  return join(directory, `${Buffer.from(sessionId, "utf8").toString("hex")}${BODY_SUFFIX}`);
}

function bodySessionId(name: string): string {
  return Buffer.from(name.slice(0, -BODY_SUFFIX.length), "hex").toString("utf8");
}

/** Write the old Memento array one session at a time: backing up a 450 MB
 * Memento must not require another 450 MB string. Rename only after a durable
 * write. */
async function writeLegacyValue(path: string, key: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(`{"key":${JSON.stringify(key)},"value":`);
      if (Array.isArray(value)) {
        await file.writeFile("[");
        for (let index = 0; index < value.length; index++) {
          await file.writeFile(`${index ? "," : ""}${JSON.stringify(value[index])}`);
        }
        await file.writeFile("]");
      } else await file.writeFile(JSON.stringify(value));
      await file.writeFile("}");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function writeDurable(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(text);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** A conversation body is one JSON object per line, so a new turn appends and
 * never rewrites the turns already on disk. */
function bodyText(turns: readonly DextHistoryRecord[]): string {
  return turns.map((turn) => `${JSON.stringify(turn)}\n`).join("");
}

function compactSession(session: DextHistorySession): DextHistorySession {
  return {
    ...session,
    turns: session.turns.map((turn) => ({ ...turn, process: compactAgentEvents(turn.process) }))
  };
}

interface HistoryIndex {
  imported: boolean;
  order: string[];
  sessions: Record<string, DextHistorySummary>;
}

function emptyIndex(): HistoryIndex {
  return { imported: false, order: [], sessions: {} };
}

function orderIndex(order: readonly string[], sessions: Record<string, DextHistorySummary>): HistoryIndex {
  const known = new Set(Object.keys(sessions));
  const listed = [...new Set(order.filter((id) => known.has(id)))];
  const missing = [...known].filter((id) => !listed.includes(id))
    .sort((left, right) => (sessions[left]?.createdAt ?? 0) - (sessions[right]?.createdAt ?? 0));
  return { ...emptyIndex(), order: [...listed, ...missing], sessions };
}

async function writeIndexFile(directory: string, index: HistoryIndex): Promise<void> {
  await writeDurable(join(directory, INDEX_FILE), JSON.stringify(index));
}

async function readIndex(directory: string): Promise<HistoryIndex | undefined> {
  let parsed: { imported?: unknown; order?: unknown; sessions?: unknown };
  try { parsed = JSON.parse(await readFile(join(directory, INDEX_FILE), "utf8")) as typeof parsed; }
  catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.order)
    || !parsed.sessions || typeof parsed.sessions !== "object") return undefined;
  const sessions: Record<string, DextHistorySummary> = {};
  for (const [id, summary] of Object.entries(parsed.sessions as Record<string, DextHistorySummary>)) {
    if (summary && typeof summary.id === "string" && typeof summary.turnCount === "number") sessions[id] = summary;
  }
  return { ...orderIndex(parsed.order.filter((id): id is string => typeof id === "string"), sessions),
    imported: parsed.imported === true };
}

/** The index is the only thing an activation parses; every conversation body
 * stays on disk until someone opens that conversation. */
export class HistoryFiles implements HistoryBackend {
  private constructor(private readonly directory: string, private index: HistoryIndex) {}

  /** Skipped files stay on disk; the callback lets activation tell the user
   * which conversations the History page cannot show. */
  static async open(directory: string, onSkipped?: (names: readonly string[]) => void): Promise<HistoryFiles> {
    await mkdir(directory, { recursive: true });
    const legacy = (await readdir(directory)).filter(isLegacyFile);
    const stored = await readIndex(directory);
    const skipped = new Set<string>();
    const files = stored
      ? new HistoryFiles(directory, stored)
      : legacy.length
        ? new HistoryFiles(directory, await migrateLegacyFiles(directory, legacy, (names) => {
          for (const name of names) skipped.add(name);
          onSkipped?.(names);
        }))
        // No index and no old files: rebuild from the bodies before assuming the
        // user's history is gone.
        : new HistoryFiles(directory, await rebuildFromBodies(directory));
    // Both are superseded now: the index holds their content and the bodies hold
    // the turns. The backup directory keeps the rollback path; an unreadable
    // file stays where the user was told to find it.
    await files.backup(legacy.filter((name) => !skipped.has(name)));
    await files.pruneOverflow();
    return files;
  }

  summaries(): DextHistorySummary[] {
    return this.index.order.flatMap((id) => {
      const summary = this.index.sessions[id];
      return summary ? [summary] : [];
    });
  }

  async read(sessionId: string): Promise<DextHistorySession | undefined> {
    const summary = this.index.sessions[sessionId];
    if (!summary) return undefined;
    let body: string;
    try {
      body = await readFile(bodyPath(this.directory, sessionId), "utf8");
    } catch (error) {
      // A missing body keeps the entry: the user must still be able to delete
      // the conversation, and a conversation may legitimately have no turns.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return historySessionOf(summary, []);
      throw error;
    }
    const turns: DextHistoryRecord[] = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try { turns.push(JSON.parse(line) as DextHistoryRecord); }
      catch (error) {
        // One damaged line must not hide the rest of the conversation.
        console.warn(`Dext skipped a damaged turn in conversation history: ${sessionId}`, error);
      }
    }
    // The body is the truth: a crash may have landed between the append and the
    // index write. Repairing here keeps the next History list honest.
    if (turns.length !== summary.turnCount) {
      this.index.sessions[sessionId] = historySummaryOf(historySessionOf(summary, turns));
      await this.writeIndex();
    }
    return historySessionOf(summary, turns);
  }

  async appendTurn(sessionId: string, turn: DextHistoryRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = await open(bodyPath(this.directory, sessionId), "a");
    try {
      await file.writeFile(`${JSON.stringify(turn)}\n`);
      await file.sync();
    } finally { await file.close(); }
    // shortcut: the count is incremented, not recounted; a crash between this
    // append and the index write is repaired by read() on the next visit.
    const summary = this.index.sessions[sessionId]
      ?? { id: sessionId, createdAt: turn.createdAt, updatedAt: turn.createdAt, turnCount: 0 };
    const spills = turn.spillPath ? { ...summary.spills, [turn.id]: turn.spillPath } : summary.spills;
    this.put({
      ...summary,
      updatedAt: turn.createdAt,
      turnCount: summary.turnCount + 1,
      ...(summary.firstInput === undefined ? { firstInput: turn.input } : {}),
      ...(spills && Object.keys(spills).length ? { spills } : {})
    });
    await this.writeIndex();
  }

  async writeTurns(session: DextHistorySession): Promise<void> {
    await writeBody(this.directory, session);
    this.put(historySummaryOf(session));
    await this.writeIndex();
  }

  async writeMeta(summary: DextHistorySummary): Promise<void> {
    this.put(summary);
    await this.writeIndex();
  }

  async remove(sessionId: string): Promise<void> {
    await rm(bodyPath(this.directory, sessionId), { force: true });
    delete this.index.sessions[sessionId];
    this.index.order = this.index.order.filter((id) => id !== sessionId);
    await this.writeIndex();
  }

  async setOrder(order: readonly string[]): Promise<void> {
    this.index.order = order.filter((id) => this.index.sessions[id]);
    await this.writeIndex();
  }

  /** Re-read the index another window may have committed since this one loaded.
   * Bodies are read from disk every time, so they cannot go stale. */
  async refresh(): Promise<void> {
    const stored = await readIndex(this.directory);
    if (stored) this.index = stored;
  }

  async writeSpill(parts: readonly string[]): Promise<string | undefined> {
    const path = join(this.directory, "overflow", `${randomBytes(8).toString("hex")}.txt`);
    try {
      await mkdir(join(this.directory, "overflow"), { recursive: true });
      await writeDurable(path, parts.map((part, index) => `=== part ${index + 1} (${part.length} chars) ===\n${part}\n`).join(""));
      return path;
    } catch {
      return undefined;
    }
  }

  /** A completed Memento import no longer needs its raw copy, but an interrupted
   * one does; the marker lives in the index so no second file can drift. */
  imported(): boolean {
    return this.index.imported;
  }

  async markImported(): Promise<void> {
    this.index.imported = true;
    await this.writeIndex();
  }

  private put(summary: DextHistorySummary): void {
    this.index.sessions[summary.id] = summary;
    if (!this.index.order.includes(summary.id)) this.index.order.push(summary.id);
  }

  private async writeIndex(): Promise<void> {
    await writeIndexFile(this.directory, this.index);
  }

  private async backup(names: readonly string[]): Promise<void> {
    if (!names.length) return;
    const directory = join(this.directory, "legacy-backup");
    await mkdir(directory, { recursive: true });
    for (const name of names) {
      try { await rename(join(this.directory, name), join(directory, name)); }
      catch { /* another window moved it first */ }
    }
  }

  /** Overflow text is only reachable through a turn's spill path, and those are
   * in the index, so this never reads a body. */
  private async pruneOverflow(): Promise<void> {
    const overflow = join(this.directory, "overflow");
    try {
      const referenced = new Set<string>();
      for (const summary of Object.values(this.index.sessions)) {
        for (const path of Object.values(summary.spills ?? {})) referenced.add(path);
      }
      for (const name of await readdir(overflow)) {
        const path = join(overflow, name);
        if (referenced.has(path)) continue;
        if (Date.now() - (await stat(path)).mtimeMs < OVERFLOW_MAX_AGE_MS) continue;
        await rm(path, { force: true });
      }
    } catch { /* no overflow directory yet */ }
  }
}

async function writeBody(directory: string, session: DextHistorySession): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeDurable(bodyPath(directory, session.id), bodyText(session.turns));
}

async function readBody(directory: string, name: string): Promise<DextHistorySession | undefined> {
  try {
    const turns = (await readFile(join(directory, name), "utf8")).split("\n").filter((line) => line.trim())
      .flatMap((line) => {
        try { return [JSON.parse(line) as DextHistoryRecord]; }
        catch { return []; }
      });
    const first = turns[0];
    if (!first) return undefined;
    return { id: bodySessionId(name), createdAt: first.createdAt, updatedAt: turns.at(-1)!.createdAt, turns };
  } catch { return undefined; }
}

/** An index that is lost or damaged is rebuilt from the bodies, one parse per
 * conversation; that is cheap enough to beat keeping a second copy in sync. */
async function rebuildFromBodies(directory: string): Promise<HistoryIndex> {
  const sessions: Record<string, DextHistorySummary> = {};
  const order: string[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(BODY_SUFFIX)) continue;
    const session = await readBody(directory, name);
    if (!session) continue;
    sessions[session.id] = historySummaryOf(session);
    order.push(session.id);
  }
  if (order.length) {
    const index = orderIndex(order, sessions);
    await writeIndexFile(directory, index);
    console.warn(`Dext rebuilt the conversation index from ${order.length} conversation body file(s).`);
    return index;
  }
  return emptyIndex();
}

/** The obsolete layout stored every Memento key as `<sha>.json`. One pass turns
 * it into bodies plus an index; the files only move once that index is durable,
 * so an interrupted migration re-runs from the same sources. */
async function migrateLegacyFiles(
  directory: string,
  names: readonly string[],
  onSkipped?: (names: readonly string[]) => void
): Promise<HistoryIndex> {
  const sessions = new Map<string, DextHistorySession>();
  const skipped: string[] = [];
  let order: string[] = [];
  let imported = false;
  for (const name of names) {
    try {
      const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as { key: unknown; value: unknown };
      if (typeof entry.key !== "string" || legacyFilePath(directory, entry.key) !== join(directory, name)) {
        throw new Error("the file name does not match the key inside it");
      }
      if (entry.key === HISTORY_KEY) {
        const stored = Array.isArray(entry.value) ? entry.value as (DextHistoryRecord | DextHistorySession)[] : [];
        for (const item of stored) {
          const session = legacyHistorySession(item);
          if (typeof session.id === "string" && Array.isArray(session.turns)) sessions.set(session.id, session);
        }
      } else if (entry.key === ORDER_KEY) {
        order = Array.isArray(entry.value) ? entry.value.filter((id): id is string => typeof id === "string") : [];
      } else if (entry.key === IMPORTED_KEY) {
        imported = entry.value === true;
      } else if (entry.key.startsWith(SESSION_PREFIX)) {
        const session = entry.value as DextHistorySession;
        if (typeof session?.id !== "string" || !Array.isArray(session.turns)) throw new Error("not a conversation");
        sessions.set(session.id, session);
      }
    } catch (error) {
      // One damaged file must not fail activation: skip it, keep every other
      // conversation, and leave the file on disk for the user to inspect.
      skipped.push(name);
      console.warn(`Dext ignored an unreadable conversation history file: ${name}`, error);
    }
  }
  if (skipped.length) onSkipped?.(skipped);
  const index = orderIndex(order, Object.fromEntries([...sessions.values()].map((session) => [session.id, historySummaryOf(session)])));
  for (const session of sessions.values()) await writeBody(directory, compactSession(session));
  await writeIndexFile(directory, { ...index, imported });
  return { ...index, imported };
}

/** A completed backup no longer needs its raw copy, but an interrupted one does.
 * A failed cleanup must never block activation. */
async function pruneLegacyBackup(directory: string): Promise<void> {
  const backup = join(directory, "legacy-backup");
  try {
    let newest = 0;
    for (const name of await readdir(backup)) {
      newest = Math.max(newest, (await stat(join(backup, name))).mtimeMs);
    }
    if (Date.now() - newest > BACKUP_MAX_AGE_MS) await rm(backup, { recursive: true, force: true });
  } catch { /* no backup, or another window already removed it */ }
}

/** Import before exposing commands/sidebar. A completion marker makes a crash
 * between disk commit and Memento cleanup retry cleanup without resurrecting
 * deleted turns. Orphan session keys from an interrupted old migration count
 * even when its order key was never written. */
export async function openFileHistoryStore(
  directory: string, legacy: vscode.Memento,
  readLimits: () => DextHistoryLimits = () => DEFAULT_HISTORY_LIMITS,
  onSkipped?: (names: readonly string[]) => void
): Promise<DextHistoryStore> {
  const files = await HistoryFiles.open(directory, onSkipped);
  const keys = legacy.keys().filter(historyKey);
  if (keys.length && !files.imported()) {
    const backup = join(directory, "legacy-backup");
    await mkdir(backup, { recursive: true });
    // Complete every original backup before changing any source key.
    for (const key of keys) {
      const value = legacy.get(key);
      if (value !== undefined) await writeLegacyValue(legacyFilePath(backup, key), key, value);
    }
    const sessions = new Map<string, DextHistorySession>();
    const previous = legacy.get<(DextHistoryRecord | DextHistorySession)[]>(HISTORY_KEY, []);
    for (const item of previous) {
      const session = legacyHistorySession(item);
      sessions.set(session.id, session);
    }
    const indexed = legacy.get<string[]>(ORDER_KEY, []);
    const sessionKeys = [...new Set([
      ...indexed.map((id) => `${SESSION_PREFIX}${id}`), ...keys.filter((key) => key.startsWith(SESSION_PREFIX))
    ])];
    for (const key of sessionKeys) {
      const session = legacy.get<DextHistorySession>(key);
      if (session) sessions.set(session.id, session);
    }
    for (const session of sessions.values()) await files.writeTurns(compactSession(session));
    await files.markImported();
  }
  // VS Code coalesces synchronous Memento.update calls. Delete all history keys
  // in one batch, so even cleanup never sends the old history per session.
  await Promise.all(keys.map((key) => legacy.update(key, undefined)));
  await pruneLegacyBackup(directory);
  return new DextHistoryStore(files, readLimits);
}
