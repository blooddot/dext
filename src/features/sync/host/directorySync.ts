import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { historySummaryOf, type DextHistoryRecord, type DextHistorySummary } from "../../conversations/contracts/history.js";
import type {
  SyncHistoryIndex,
  SyncHistoryPort,
  SyncOutcome,
  SyncPreferenceBridge,
  SyncPreferences
} from "../contracts/sync.js";
import { mergePreferences, mergeSummary, mergeTurns, samePreferences } from "../domain/syncMerge.js";

const CONVERSATIONS = "conversation-history";
const STATE_FILE = ".sync-state.json";
const TOMBSTONES_FILE = "tombstones.json";
const PREFERENCES_FILE = "preferences.json";
const OVERFLOW = "overflow";

interface SyncState {
  /** Session ids this machine had at the end of its last successful sync. A
   * session missing now was deleted here, not merely absent from the other
   * machine. */
  sessions: string[];
}

interface Tombstones {
  [sessionId: string]: number;
}

export interface DirectorySyncOptions {
  /** Access to the on-disk history layout, supplied by `app`. */
  history: SyncHistoryPort;
  /** The extension's local `conversation-history` directory. */
  historyDir: string;
  /** A folder the user chose, usually inside a cloud drive. */
  syncRoot: string;
  preferences?: SyncPreferenceBridge;
  /** Local attachment directories (global or workspace, depending on settings). */
  attachmentDirectory?: string | undefined;
  planDirectory?: string | undefined;
  includeAttachments?: boolean;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return fallback; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function entries(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch { return []; }
}

/** Property order differs between a parsed file and a freshly merged object,
 * so an ordinary JSON comparison would rewrite unchanged files on every run
 * and make the cloud client upload the whole history each time. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch { return undefined; }
}

function summaryFromTurns(id: string, turns: readonly DextHistoryRecord[]): DextHistorySummary {
  const first = turns[0]?.createdAt ?? Date.now();
  return historySummaryOf({
    id,
    createdAt: first,
    updatedAt: turns.at(-1)?.createdAt ?? first,
    turns: [...turns]
  });
}

/** An index is normally written at activation, but a synced folder can be read
 * before that on a fresh machine; the bodies are enough to rebuild it. */
async function indexOf(history: SyncHistoryPort, directory: string): Promise<SyncHistoryIndex> {
  const stored = await history.readIndex(directory);
  if (stored) return stored;
  const index: SyncHistoryIndex = { imported: true, order: [], sessions: {} };
  for (const name of await entries(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    let sessionId: string;
    try { sessionId = history.sessionIdFromBodyFile(name); }
    catch { continue; }
    const turns = await history.readBody(directory, sessionId) ?? [];
    if (!turns.length) continue;
    index.sessions[sessionId] = summaryFromTurns(sessionId, turns);
    index.order.push(sessionId);
  }
  return index;
}

function mergeOrder(local: readonly string[], remote: readonly string[], sessions: Record<string, DextHistorySummary>): string[] {
  // The order lists are the user's manual arrangement; keep local first, then
  // anything only the other machine knew, then sessions neither listed.
  const known = new Set(Object.keys(sessions));
  const listed = [...new Set([...local, ...remote])].filter((id) => known.has(id));
  const missing = [...known]
    .filter((id) => !listed.includes(id))
    .sort((left, right) => (sessions[left]?.createdAt ?? 0) - (sessions[right]?.createdAt ?? 0));
  return [...listed, ...missing];
}

async function copyResource(history: SyncHistoryPort, from: string, to: string, sessionId: string): Promise<void> {
  const source = history.resourceFile(from, sessionId);
  const content = await readText(source);
  if (content === undefined) return;
  const target = history.resourceFile(to, sessionId);
  if (await readText(target) === content) return;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Overflow files keep a turn's untruncated text. The index still names an
 * absolute path, which only resolves on the machine that wrote it; copying the
 * files at least keeps the content available next to the history. */
async function copyOverflow(from: string, to: string): Promise<void> {
  const source = join(from, OVERFLOW);
  const target = join(to, OVERFLOW);
  const names = await entries(source);
  if (!names.length) return;
  await mkdir(target, { recursive: true });
  for (const name of names) {
    try { await stat(join(target, name)); continue; }
    catch { /* absent: copy it */ }
    try { await copyFile(join(source, name), join(target, name)); }
    catch { /* another window or machine is writing it */ }
  }
}

/** Copy missing or newer files both ways. Attachments are content-addressed and
 * plans are name-addressed, so the mtime is the only ordering signal there is. */
async function copyNewer(from: string, to: string): Promise<number> {
  let copied = 0;
  for (const name of await entries(from)) {
    if (name.startsWith(".")) continue;
    const source = join(from, name);
    const target = join(to, name);
    try {
      const info = await stat(source);
      if (!info.isFile()) continue;
      let targetTime = 0;
      try { targetTime = (await stat(target)).mtimeMs; } catch { /* absent */ }
      if (targetTime >= info.mtimeMs) continue;
      await copyFile(source, target);
      copied++;
    } catch { /* one unreadable file must not abort the sync */ }
  }
  return copied;
}

async function copyDirectoryBothWays(local: string | undefined, remote: string): Promise<number> {
  if (!local) return 0;
  if (resolve(local) === resolve(remote)) return 0;
  await mkdir(remote, { recursive: true });
  const out = await copyNewer(local, remote);
  return out + await copyNewer(remote, local);
}

export function validateSyncRoot(historyDir: string, syncRoot: string): void {
  if (!syncRoot.trim()) throw new Error("Choose a folder for Dext sync first.");
  const local = resolve(historyDir);
  const root = resolve(syncRoot);
  if (root === local || root.startsWith(local + sep) || local.startsWith(root + sep)) {
    throw new Error("The sync folder must be outside Dext's own history folder.");
  }
}

export async function syncDirectory(options: DirectorySyncOptions): Promise<SyncOutcome> {
  validateSyncRoot(options.historyDir, options.syncRoot);
  const { history } = options;
  const remoteHistory = join(resolve(options.syncRoot), CONVERSATIONS);
  await mkdir(remoteHistory, { recursive: true });
  await mkdir(resolve(options.historyDir), { recursive: true });

  const localIndex = await indexOf(history, resolve(options.historyDir));
  const remoteIndex = await indexOf(history, remoteHistory);
  const tombstonesPath = join(resolve(options.syncRoot), TOMBSTONES_FILE);
  const statePath = join(resolve(options.historyDir), STATE_FILE);
  const tombstones = await readJson<Tombstones>(tombstonesPath, {});
  const state = await readJson<SyncState>(statePath, { sessions: [] });

  // A session this machine had last time but no longer has was deleted here.
  const localIds = new Set(Object.keys(localIndex.sessions));
  let deletedHere = 0;
  for (const id of state.sessions) {
    if (localIds.has(id) || tombstones[id] !== undefined) continue;
    tombstones[id] = Date.now();
    deletedHere++;
  }

  const deleted = Object.keys(tombstones);
  for (const id of deleted) {
    await rm(history.bodyFile(resolve(options.historyDir), id), { force: true });
    await rm(history.bodyFile(remoteHistory, id), { force: true });
    await rm(history.resourceFile(resolve(options.historyDir), id), { force: true });
    await rm(history.resourceFile(remoteHistory, id), { force: true });
    delete localIndex.sessions[id];
    delete remoteIndex.sessions[id];
  }
  localIndex.order = localIndex.order.filter((id) => !tombstones[id]);
  remoteIndex.order = remoteIndex.order.filter((id) => !tombstones[id]);

  const ids = new Set([...Object.keys(localIndex.sessions), ...Object.keys(remoteIndex.sessions)]);
  const sessions: Record<string, DextHistorySummary> = {};
  let pulled = 0;
  let pushed = 0;

  for (const id of ids) {
    const localTurns = await history.readBody(resolve(options.historyDir), id) ?? [];
    const remoteTurns = await history.readBody(remoteHistory, id) ?? [];
    const localSummary = localIndex.sessions[id] ?? summaryFromTurns(id, localTurns);
    const remoteSummary = remoteIndex.sessions[id] ?? summaryFromTurns(id, remoteTurns);
    const turns = mergeTurns(localTurns, remoteTurns, localSummary.updatedAt >= remoteSummary.updatedAt);
    sessions[id] = mergeSummary(localSummary, remoteSummary, turns);

    const localTurnIds = new Set(localTurns.map((turn) => turn.id));
    const remoteTurnIds = new Set(remoteTurns.map((turn) => turn.id));
    if ([...remoteTurnIds].some((turnId) => !localTurnIds.has(turnId))) pulled++;
    if ([...localTurnIds].some((turnId) => !remoteTurnIds.has(turnId))) pushed++;

    if (turns.length) {
      if (!sameValue(turns, localTurns)) await history.writeBody(resolve(options.historyDir), id, turns);
      if (!sameValue(turns, remoteTurns)) await history.writeBody(remoteHistory, id, turns);
    } else {
      await rm(history.bodyFile(resolve(options.historyDir), id), { force: true });
      await rm(history.bodyFile(remoteHistory, id), { force: true });
    }
    await copyResource(history, resolve(options.historyDir), remoteHistory, id);
    await copyResource(history, remoteHistory, resolve(options.historyDir), id);
  }

  const order = mergeOrder(localIndex.order, remoteIndex.order, sessions);
  const localNext = { imported: localIndex.imported, order, sessions };
  const remoteNext = { imported: true, order, sessions };
  if (!sameValue(localNext, localIndex)) await history.writeIndex(resolve(options.historyDir), localNext);
  if (!sameValue(remoteNext, remoteIndex)) await history.writeIndex(remoteHistory, remoteNext);
  await copyOverflow(resolve(options.historyDir), remoteHistory);
  await copyOverflow(remoteHistory, resolve(options.historyDir));
  await writeJson(statePath, { sessions: Object.keys(sessions) } satisfies SyncState);
  if (deletedHere) await writeJson(tombstonesPath, tombstones);

  let preferencesMerged = false;
  if (options.preferences) {
    const path = join(resolve(options.syncRoot), PREFERENCES_FILE);
    const remote = await readJson<SyncPreferences | undefined>(path, undefined);
    const local = options.preferences.read();
    const merged = remote ? mergePreferences(local, remote) : local;
    preferencesMerged = !remote || !samePreferences(local, merged);
    await options.preferences.adopt(merged);
    if (!remote || !samePreferences(merged, remote)) await writeJson(path, merged);
  }

  const root = resolve(options.syncRoot);
  const copiedAttachments = options.includeAttachments === false
    ? 0
    : await copyDirectoryBothWays(options.attachmentDirectory, join(root, "attachments"));
  const copiedPlans = await copyDirectoryBothWays(options.planDirectory, join(root, "plans"));

  return {
    pulledSessions: pulled,
    pushedSessions: pushed,
    deletedSessions: deletedHere,
    copiedAttachments,
    copiedPlans,
    preferencesMerged
  };
}
