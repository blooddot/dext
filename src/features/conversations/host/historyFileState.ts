import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type * as vscode from "vscode";
import { DEFAULT_HISTORY_LIMITS, type DextHistoryLimits, type DextHistoryRecord, type DextHistorySession } from "../contracts/history.js";
import { compactAgentEvents } from "../domain/agentEventLog.js";
import { DextHistoryStore } from "./historyStore.js";

const HISTORY_KEY = "dext.history";
const SESSION_PREFIX = "dext.history.session:";
const ORDER_KEY = "dext.history.order";
const IMPORTED_KEY = "dext.history.imported";

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
    const order = state.get<string[]>(ORDER_KEY, []);
    const missing = [...state.values.keys()].filter((key) => key.startsWith(SESSION_PREFIX))
      .map((key) => state.get<DextHistorySession>(key))
      .filter((session) => !order.includes(session.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (missing.length) await state.update(ORDER_KEY, [...order, ...missing.map((session) => session.id)]);
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
  if (keys.length && !state.get(IMPORTED_KEY, false)) {
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
  return new DextHistoryStore(state, readLimits);
}
