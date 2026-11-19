import * as vscode from "vscode";
import {
  syncChanged,
  type SyncHistoryPort,
  type SyncHistoryQueue,
  type SyncOutcome,
  type SyncPreferenceBridge,
  type SyncSettings
} from "../contracts/sync.js";
import { syncDirectory } from "./directorySync.js";

/** A store write is followed by a short pause so a burst of turns (retry,
 * plan progress, provider ids) becomes one sync instead of five. */
const WRITE_DEBOUNCE_MS = 4_000;
/** Window focus and the periodic timer can both fire within a moment; one sync
 * per half minute is enough for a cloud folder. */
const MIN_SPONTANEOUS_GAP_MS = 30_000;

export interface DextSyncBindings {
  historyDir: string;
  history: SyncHistoryPort;
  queue: SyncHistoryQueue;
  preferences: SyncPreferenceBridge;
  /** Derived from `dext.storage.location`; undefined when no workspace is open
   * and the setting asks for workspace storage. */
  attachmentDirectory: () => string | undefined;
  planDirectory: () => string | undefined;
  /** Re-reads the merged index and repaints the surfaces that list it. */
  refresh: () => Promise<void>;
}

function describe(outcome: SyncOutcome): string {
  const parts: string[] = [];
  if (outcome.pulledSessions) parts.push(`${outcome.pulledSessions} pulled`);
  if (outcome.pushedSessions) parts.push(`${outcome.pushedSessions} pushed`);
  if (outcome.deletedSessions) parts.push(`${outcome.deletedSessions} deleted`);
  if (outcome.copiedAttachments) parts.push(`${outcome.copiedAttachments} files`);
  if (outcome.copiedPlans) parts.push(`${outcome.copiedPlans} plans`);
  return parts.join(", ");
}

export class DextSyncController implements vscode.Disposable {
  private readonly listeners: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private running = false;
  private queued = false;
  private lastSyncAt = 0;
  private lastError: string | undefined;

  constructor(private readonly bindings: DextSyncBindings) {}

  start(): void {
    this.listeners.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("dext.sync")) return;
      this.configure();
      this.schedule();
    }));
    this.listeners.push(vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void this.syncNow(false);
    }));
    this.configure();
    void this.syncNow(false);
  }

  /** Called after a conversation write; coalesced so a burst syncs once. */
  schedule(): void {
    if (!this.settings().directory) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.syncNow(false);
    }, WRITE_DEBOUNCE_MS);
  }

  async syncNow(manual: boolean): Promise<void> {
    const settings = this.settings();
    if (!settings.directory) {
      if (manual) void vscode.window.showWarningMessage("Set Dext Sync: Directory before syncing.");
      return;
    }
    if (this.running) {
      this.queued = true;
      return;
    }
    if (!manual && Date.now() - this.lastSyncAt < MIN_SPONTANEOUS_GAP_MS) return;
    this.running = true;
    try {
      const outcome = await this.bindings.queue.exclusive(() => syncDirectory({
        history: this.bindings.history,
        historyDir: this.bindings.historyDir,
        syncRoot: settings.directory,
        preferences: this.bindings.preferences,
        attachmentDirectory: this.bindings.attachmentDirectory(),
        planDirectory: this.bindings.planDirectory(),
        includeAttachments: settings.attachments
      }));
      this.lastSyncAt = Date.now();
      this.lastError = undefined;
      if (syncChanged(outcome)) await this.bindings.refresh();
      const summary = describe(outcome);
      if (manual) {
        void vscode.window.showInformationMessage(summary
          ? `Dext synced: ${summary}.`
          : "Dext: conversations are already in sync.");
      } else if (summary) {
        vscode.window.setStatusBarMessage(`Dext synced: ${summary}`, 5_000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const previous = this.lastError;
      this.lastError = message;
      if (manual) void vscode.window.showErrorMessage(`Dext sync failed: ${message}`);
      else if (previous !== message) {
        // The same failure on every timer tick must not become a stream of
        // warnings; one report per distinct reason is enough.
        void vscode.window.showWarningMessage(`Dext sync failed: ${message}`);
      } else {
        console.warn("Dext sync failed", error);
      }
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        void this.syncNow(false);
      }
    }
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = undefined;
    this.debounce = undefined;
  }

  private settings(): SyncSettings {
    const configuration = vscode.workspace.getConfiguration("dext");
    const directory = configuration.get<string>("sync.directory", "").trim();
    const interval = configuration.get<number>("sync.intervalSeconds", 300);
    return {
      directory,
      intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(30, interval) : 0,
      attachments: configuration.get<boolean>("sync.attachments", true)
    };
  }

  private configure(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const { directory, intervalSeconds } = this.settings();
    if (!directory || !intervalSeconds) return;
    this.timer = setInterval(() => { void this.syncNow(false); }, intervalSeconds * 1_000);
  }
}
