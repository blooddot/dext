import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type * as vscode from "vscode";
import { DEFAULT_HISTORY_LIMITS, type DextHistoryLimits, type DextHistoryRecord, type DextHistorySession } from "../contracts/history.js";
import { compactAgentEvents } from "../domain/agentEventLog.js";
import { DextHistoryStore } from "./historyStore.js";

const HISTORY_KEY = "dext.history";
const SESSION_PREFIX = "dext.history.session:";
const ORDER_KEY = "dext.history.order";
const IMPORTED_KEY = "dext.history.imported";
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_MAX_AGE_MS = 7 * DAY_MS;
const OVERFLOW_MAX_AGE_MS = DAY_MS;

function historyKey(key: string): boolean {
  return key === HISTORY_KEY || key === ORDER_KEY || key.startsWith(SESSION_PREFIX);
}

function valuePath(directory: string, key: string): string {
  return join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

/** Write the old array one session at a time: backing up a 450 MB Memento
 * must not require another 450 MB string. Rename only after a durable write. */
async function writeValue(path: string, key: string, value: unknown): Promise<void> {
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

/** Synchronous reads serve the existing History API; writes touch one file.
 * No history body crosses VS Code's Memento IPC after migration. */
export class HistoryFileState {
  private readonly values = new Map<string, unknown>();

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<HistoryFileState> {
    await mkdir(directory, { recursive: true });
    const state = new HistoryFileState(directory);
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as { key: string; value: unknown };
      if (typeof entry.key !== "string" || valuePath(directory, entry.key) !== join(directory, name)) {
        throw new Error(`Invalid conversation history file: ${name}`);
      }
      state.values.set(entry.key, entry.value);
    }
    // A process may exit after a new session file commits but before the order
    // file does. Recover it rather than hiding a successfully written turn.
    const storedOrder = state.get<unknown>(ORDER_KEY, []);
    const order = Array.isArray(storedOrder)
      ? storedOrder.filter((id): id is string => typeof id === "string")
      : [];
    const missing = [...state.values.keys()].filter((key) => key.startsWith(SESSION_PREFIX))
      .map((key) => state.get<DextHistorySession | undefined>(key, undefined))
      .filter((session): session is DextHistorySession => typeof session?.id === "string")
      .filter((session) => !order.includes(session.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (missing.length) await state.update(ORDER_KEY, [...order, ...missing.map((session) => session.id)]);
    await pruneOverflow(directory, state.values);
    return state;
  }

  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    const path = valuePath(this.directory, key);
    if (value === undefined) {
      await rm(path, { force: true });
      this.values.delete(key);
    } else {
      await writeValue(path, key, value);
      this.values.set(key, value);
    }
  }
}

/** A completed import no longer needs its raw copy, but an interrupted one does.
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

/** Overflow text is only reachable through a turn's `spillPath`, so anything
 * unreferenced for a day is gone; the delay protects a concurrent window's
 * fresh file from this window's older snapshot. */
async function pruneOverflow(directory: string, values: ReadonlyMap<string, unknown>): Promise<void> {
  const overflow = join(directory, "overflow");
  try {
    const referenced = new Set<string>();
    for (const [key, value] of values) {
      if (!key.startsWith(SESSION_PREFIX)) continue;
      for (const turn of (value as DextHistorySession | undefined)?.turns ?? []) {
        if (typeof turn?.spillPath === "string") referenced.add(turn.spillPath);
      }
    }
    for (const name of await readdir(overflow)) {
      const path = join(overflow, name);
      if (referenced.has(path)) continue;
      if (Date.now() - (await stat(path)).mtimeMs < OVERFLOW_MAX_AGE_MS) continue;
      await rm(path, { force: true });
    }
  } catch { /* no overflow directory yet */ }
}

/** Whole text that truncation removed, one file per turn. A failed write only
 * costs the overflow copy, never the turn. */
async function writeSpill(directory: string, parts: readonly string[]): Promise<string | undefined> {
  const path = join(directory, "overflow", `${randomBytes(8).toString("hex")}.txt`);
  const temporary = `${path}.tmp`;
  try {
    await mkdir(join(directory, "overflow"), { recursive: true });
    const file = await open(temporary, "wx");
    try {
      for (const [index, part] of parts.entries()) {
        await file.writeFile(`=== part ${index + 1} (${part.length} chars) ===\n${part}\n`);
      }
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    return path;
  } catch {
    return undefined;
  } finally { await rm(temporary, { force: true }); }
}

/** Import before exposing commands/sidebar. A completion marker makes a crash
 * between disk commit and Memento cleanup retry cleanup without resurrecting
 * deleted turns. Orphan session keys from an interrupted old migration count
 * even when its order key was never written. */
export async function openFileHistoryStore(
  directory: string, legacy: vscode.Memento,
  readLimits: () => DextHistoryLimits = () => DEFAULT_HISTORY_LIMITS
): Promise<DextHistoryStore> {
  const state = await HistoryFileState.open(directory);
  const keys = legacy.keys().filter(historyKey);
  const imported = state.get<boolean>(IMPORTED_KEY, false);
  if (keys.length && !imported) {
    const backup = join(directory, "legacy-backup");
    await mkdir(backup, { recursive: true });
    // Complete every original backup before changing any source key.
    for (const key of keys) {
      const value = legacy.get(key);
      if (value !== undefined) await writeValue(valuePath(backup, key), key, value);
    }
    const sessions = new Map<string, DextHistorySession>();
    const previous = legacy.get<(DextHistoryRecord | DextHistorySession)[]>(HISTORY_KEY, []);
    for (const item of previous) {
      const session = "turns" in item ? item : {
        id: `legacy-${item.id}`, createdAt: item.createdAt, updatedAt: item.createdAt, turns: [item]
      };
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
    for (const session of sessions.values()) {
      const compact = { ...session, turns: session.turns.map((turn) => ({
        ...turn, process: compactAgentEvents(turn.process)
      })) };
      await state.update(`${SESSION_PREFIX}${session.id}`, compact);
    }
    await state.update(ORDER_KEY, [...sessions.keys()]);
    await state.update(IMPORTED_KEY, true);
  }
  // VS Code coalesces synchronous Memento.update calls. Delete all history keys
  // in one batch, so even cleanup never sends the old history per session.
  await Promise.all(keys.map((key) => legacy.update(key, undefined)));
  // Only a window that started after the import may age out the raw backup.
  if (imported) await pruneLegacyBackup(directory);
  return new DextHistoryStore(state, readLimits, (parts) => writeSpill(directory, parts));
}
