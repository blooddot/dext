import { randomInt, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fingerprint } from "./completionContext.js";

export interface CompletionMemoryStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface CompletionEpochs {
  current(root: string): string | undefined;
  prepare(root: string): Promise<void>;
  clear(root: string): Promise<string>;
}

/** Only random clear generations live here; statistics and references stay in workspaceState.
 * A late whole-Memento write cannot roll this generation backwards. */
export class CompletionMemoryEpochs implements CompletionEpochs {
  private readonly values = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private watcher: FSWatcher | undefined;
  private ready: Promise<void> | undefined;
  private disposed = false;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly directory: string) {}
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  current(root: string): string | undefined { return this.values.get(fingerprint(root)); }
  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      if (!isAbsolute(this.directory)) throw new Error("Completion epoch directory must be absolute.");
      await mkdir(this.directory, { recursive: true });
      if (this.disposed) return;
      this.watcher = watch(this.directory, { persistent: false }, (_event, file) => {
        this.revision++;
        const key = file?.toString().replace(/\.epoch$/, "");
        // Temporary writes are not a published clear. Loading a previously
        // unknown root must not cancel an otherwise valid completion either.
        if (file?.toString().endsWith(".tmp")) return;
        const changed = key && /^[a-f0-9]{24}$/.test(key) ? this.values.delete(key) : this.values.size > 0;
        if (!key || !/^[a-f0-9]{24}$/.test(key)) this.values.clear();
        if (changed) for (const listener of this.listeners) listener();
      });
      this.watcher.on("error", () => {
        this.revision++; this.values.clear(); this.watcher?.close(); this.watcher = undefined; this.ready = undefined;
        for (const listener of this.listeners) listener();
      });
    })().catch((error: unknown) => { this.ready = undefined; throw error; });
    return this.ready;
  }
  prepare(root: string): Promise<void> {
    const key = fingerprint(root);
    if (this.disposed || this.values.has(key)) return Promise.resolve();
    const pending = this.pending.get(key); if (pending) return pending;
    if (this.pending.size >= 8) return Promise.resolve();
    const promise = this.load(key).catch(() => { this.values.delete(key); }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise); return promise;
  }
  private async load(key: string): Promise<void> {
    await this.initialize(); if (this.disposed) return;
    const revision = this.revision;
    const path = join(this.directory, key + ".epoch");
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(randomUUID()); } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const file = await open(path, "r");
    let value: string;
    try {
      if ((await file.stat()).size > 128) return;
      value = await file.readFile("utf8");
    } finally { await file.close(); }
    if (!this.disposed && revision === this.revision && /^[a-f0-9-]{36}$/.test(value)) {
      this.values.set(key, value);
      while (this.values.size > 8) this.values.delete(this.values.keys().next().value!);
    }
  }
  async clear(root: string): Promise<string> {
    await this.initialize();
    const key = fingerprint(root); const epoch = randomUUID();
    const temporary = join(this.directory, `${key}-${epoch}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(epoch); } finally { await file.close(); }
    try { await rename(temporary, join(this.directory, key + ".epoch")); }
    finally { await unlink(temporary).catch(() => undefined); }
    // Verify the winner if two windows clear concurrently.
    this.values.delete(key); await this.load(key);
    for (const listener of this.listeners) listener();
    // Returning our generation is sufficient when a concurrent clear won: snapshots
    // must still match the independently loaded current generation before use.
    return this.values.get(key) ?? epoch;
  }
  dispose(): void { this.disposed = true; this.watcher?.close(); this.listeners.clear(); this.values.clear(); }
}
export type FeedbackKind = "retained" | "undone" | "modified" | "unknown";
export interface MemoryBucket { retained: number; undone: number; modified: number; updated: number }
export interface ExampleReference { path: string; offset: number; length: number; hash: string; updated: number }
interface MemoryRecord { version: 1; epoch: string; updated: number; buckets: Record<string, MemoryBucket>; examples: ExampleReference[]; removed: string[] }
const TTL = 30 * 24 * 60 * 60 * 1000;
const PREFIX = "dext.completion.memory.";
export const EMPTY_BUCKET = (): MemoryBucket => ({ retained: 0, undone: 0, modified: 0, updated: 0 });
export function validExample(value: ExampleReference): boolean {
  return typeof value.path === "string" && !/^[/\\]|^[a-z]:/i.test(value.path)
    && !value.path.split(/[/\\]/).some((part) => part === ".." || !part)
    && Number.isSafeInteger(value.offset) && value.offset >= 0 && Number.isSafeInteger(value.length)
    && value.length > 0 && value.length <= 2000 && /^[a-f0-9]{24}$/.test(value.hash);
}
function empty(epoch = ""): MemoryRecord { return { version: 1, epoch, updated: 0, buckets: {}, examples: [], removed: [] }; }
function sanitize(value: unknown, epoch: string, now: number): MemoryRecord {
  if (!value || typeof value !== "object") return empty(epoch);
  const source = value as Partial<MemoryRecord>;
  if (source.version !== 1 || source.epoch !== epoch || !Number.isFinite(source.updated) || source.updated! > now || now - source.updated! > TTL) return empty(epoch);
  const result = empty(epoch);
  result.updated = source.updated!;
  for (const [key, bucket] of Object.entries(source.buckets ?? {}).slice(-128)) {
    if (!/^[a-f0-9]{24}$/.test(key) || !bucket || !Number.isFinite(bucket.updated) || bucket.updated > now || now - bucket.updated > TTL) continue;
    if ([bucket.retained, bucket.undone, bucket.modified].some((v) => !Number.isFinite(v) || v < 0 || v > 1e7)) continue;
    result.buckets[key] = { retained: bucket.retained, undone: bucket.undone, modified: bucket.modified, updated: bucket.updated };
  }
  result.examples = Array.isArray(source.examples) ? source.examples.filter((e) => e && validExample(e) && Number.isFinite(e.updated) && e.updated <= now && now - e.updated <= TTL).slice(-24)
    .map((e) => ({ path: e.path, offset: e.offset, length: e.length, hash: e.hash, updated: e.updated })) : [];
  result.removed = Array.isArray(source.removed) ? source.removed.filter((id) => typeof id === "string" && /^[a-f0-9]{24}$/.test(id)).slice(-24) : [];
  return result;
}

/** Eight fixed storage slots bound retained data even when concurrent Memento writes lose an index.
 * Slot collisions may lose weak statistics, never source edits. Epochs invalidate old slots. */
export class CompletionMemory {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly dirty = new Set<string>();
  private readonly shard = randomInt(8);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes = Promise.resolve();
  private generation = 0;
  private readonly clearing = new Map<string, Promise<void>>();
  private readonly unreadable = new Set<string>();
  private disposed = false;
  private mode: "off" | "session" | "workspace";
  private failure = false;
  constructor(private readonly store?: CompletionMemoryStore, mode: "off" | "session" | "workspace" = "workspace", private readonly now = Date.now, private readonly epochs?: CompletionEpochs) { this.mode = mode; }
  private key(root: string): string { return PREFIX + fingerprint(root); }
  private epoch(root: string): string {
    if (this.mode !== "workspace") return "";
    if (this.epochs) { void this.epochs.prepare(root); return this.epochs.current(root) ?? "unavailable"; }
    return this.store?.get<string>(this.key(root) + ".epoch") ?? "";
  }
  private load(root: string): MemoryRecord {
    const epoch = this.epoch(root);
    const cached = this.records.get(root);
    if (cached?.epoch === epoch) return cached;
    const record = this.mode === "workspace" && epoch !== "unavailable"
      ? sanitize(this.store?.get(`${this.key(root)}.slot.${this.shard}`), epoch, this.now()) : empty(epoch);
    this.records.set(root, record);
    while (this.records.size > 8) { const oldest = this.records.keys().next().value!; this.records.delete(oldest); this.dirty.delete(oldest); }
    return record;
  }
  private snapshots(root: string): MemoryRecord[] {
    if (this.mode !== "workspace" || !this.store) return [];
    return Array.from({ length: 8 }, (_, id) => id).filter((id) => id !== this.shard)
      .map((id) => sanitize(this.store!.get(`${this.key(root)}.slot.${id}`), this.epoch(root), this.now()));
  }
  bucket(root: string, key: string): MemoryBucket {
    if (this.mode === "off" || this.unreadable.has(root)) return EMPTY_BUCKET();
    const total = EMPTY_BUCKET();
    for (const record of [...this.snapshots(root), this.load(root)]) {
      const b = record.buckets[key];
      if (!b || this.now() - b.updated > TTL) continue;
      const decay = 2 ** (-Math.max(0, this.now() - b.updated) / (7 * 86400_000));
      total.retained += b.retained * decay; total.undone += b.undone * decay; total.modified += b.modified * decay;
      total.updated = Math.max(total.updated, b.updated);
    }
    return total;
  }
  record(root: string, key: string, outcome: FeedbackKind): void {
    if (this.mode === "off" || this.unreadable.has(root) || outcome === "unknown") return;
    const record = this.load(root);
    const prior = record.buckets[key] ?? EMPTY_BUCKET();
    const decay = prior.updated ? 2 ** (-Math.max(0, this.now() - prior.updated) / (7 * 86400_000)) : 1;
    record.buckets[key] = { retained: prior.retained * decay, undone: prior.undone * decay, modified: prior.modified * decay, updated: this.now() };
    record.buckets[key][outcome]++;
    while (Object.keys(record.buckets).length > (this.mode === "workspace" ? 16 : 128)) delete record.buckets[Object.keys(record.buckets)[0]!];
    this.changed(root, record);
  }
  examples(root: string): ExampleReference[] {
    if (this.mode === "off" || this.unreadable.has(root)) return [];
    const result = new Map<string, ExampleReference>();
    const records = [...this.snapshots(root), this.load(root)];
    const removed = new Set(records.flatMap((record) => record.removed));
    for (const record of records) {
      for (const e of record.examples) if (this.now() - e.updated <= TTL) result.set(`${e.path}:${e.hash}`, e);
    }
    return [...result.values()].filter((e) => !removed.has(fingerprint(e.path + ":" + e.hash))).sort((a, b) => b.updated - a.updated).slice(0, 24);
  }
  removeExample(root: string, example: ExampleReference): void {
    if (this.mode === "off" || this.unreadable.has(root)) return;
    const record = this.load(root); const id = fingerprint(example.path + ":" + example.hash);
    if (record.removed.includes(id)) return;
    record.removed = [...record.removed, id].slice(-24);
    record.examples = record.examples.filter((e) => e.path !== example.path || e.hash !== example.hash);
    this.changed(root, record);
  }
  addExample(root: string, example: ExampleReference): void {
    if (this.mode === "off" || this.unreadable.has(root) || !validExample(example)) return;
    const record = this.load(root);
    record.examples = record.examples.filter((e) => e.path !== example.path || e.hash !== example.hash);
    record.examples.push(example); record.examples = record.examples.slice(this.mode === "workspace" ? -3 : -24);
    this.changed(root, record);
  }
  private changed(root: string, record: MemoryRecord): void {
    record.updated = this.now(); this.dirty.add(root);
    this.scheduleFlush();
  }
  private scheduleFlush(): void {
    if (!this.disposed && this.mode === "workspace" && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 30_000);
    this.timer?.unref();
  }
  flush(): Promise<void> {
    if (this.mode !== "workspace" || !this.store) return Promise.resolve();
    const generation = this.generation;
    const batch = [...this.dirty]; this.dirty.clear();
    this.writes = this.writes.then(async () => {
      for (const root of batch) {
        if (generation !== this.generation || this.mode !== "workspace") return;
        const record = this.records.get(root);
        if (!record || record.epoch === "unavailable" || record.epoch !== this.epoch(root)) continue;
        const key = this.key(root);
        const value = sanitize(record, record.epoch, this.now());
        // Eight bounded window shards together fit the per-root ceiling.
        value.buckets = Object.fromEntries(Object.entries(value.buckets).sort((a, b) => b[1].updated - a[1].updated).slice(0, 16));
        value.examples = value.examples.sort((a, b) => b.updated - a.updated).slice(0, 3);
        while (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 && value.examples.length) value.examples.pop();
        if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) continue;
        try { await this.store!.update(`${key}.slot.${this.shard}`, value); }
        catch {
          this.failure = true;
          if (generation === this.generation && !this.unreadable.has(root)) this.dirty.add(root);
          continue;
        }
        if (generation !== this.generation || record.epoch !== this.epoch(root)) { await this.store!.update(`${key}.slot.${this.shard}`, undefined); continue; }
      }
    }).catch(() => { this.failure = true; }).finally(() => { if (this.dirty.size) this.scheduleFlush(); });
    return this.writes;
  }
  clear(root: string): Promise<void> {
    const pending = this.clearing.get(root); if (pending) return pending;
    // Stop using the old generation before asynchronous disk work starts. Failed
    // clears remain unreadable until an explicit retry successfully finishes.
    this.unreadable.add(root);
    this.generation++; this.records.delete(root); this.dirty.delete(root);
    const operation = (async () => {
      const epoch = this.epochs ? await this.epochs.clear(root) : randomUUID();
      if (this.store) {
        await this.writes;
        const key = this.key(root);
        await this.store.update(`${key}.epoch`, epoch);
        for (let id = 0; id < 8; id++) await this.store.update(`${key}.slot.${id}`, undefined);
      }
      this.unreadable.delete(root);
    })().catch((error: unknown) => { this.failure = true; throw error; }).finally(() => { this.clearing.delete(root); });
    this.clearing.set(root, operation); return operation;
  }
  setMode(mode: "off" | "session" | "workspace", roots: readonly string[] = []): void {
    if (mode === this.mode) return;
    this.generation++;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (mode === "session") for (const root of new Set([...this.records.keys(), ...roots])) void this.clear(root).catch(() => { this.failure = true; });
    this.records.clear(); this.dirty.clear(); this.mode = mode;
  }
  report() {
    return { mode: this.mode, roots: this.records.size, storageFailure: this.failure,
      groups: [...this.records.values()].reduce((n, record) => n + Object.keys(record.buckets).length, 0),
      references: [...this.records.values()].reduce((n, record) => n + record.examples.length, 0),
      samples: [...this.records.values()].reduce((n, record) => n + Object.values(record.buckets).reduce((sum, b) => sum + b.retained + b.undone + b.modified, 0), 0) };
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; void this.flush(); }
}
