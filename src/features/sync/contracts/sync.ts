import type { AgentSelection } from "../../agents/contracts/agent.js";
import type { DextHistoryRecord, DextHistorySummary } from "../../conversations/contracts/history.js";
import type { ComposerDraft, ConversationLayout } from "../../conversations/contracts/preferences.js";

/** The on-disk history layout, narrowed to what sync touches. `app` supplies
 * the implementation so this feature does not reach into the conversations
 * host directly. */
export interface SyncHistoryIndex {
  imported: boolean;
  order: string[];
  sessions: Record<string, DextHistorySummary>;
}

export interface SyncHistoryPort {
  readIndex(directory: string): Promise<SyncHistoryIndex | undefined>;
  writeIndex(directory: string, index: SyncHistoryIndex): Promise<void>;
  readBody(directory: string, sessionId: string): Promise<DextHistoryRecord[] | undefined>;
  writeBody(directory: string, sessionId: string, turns: readonly DextHistoryRecord[]): Promise<void>;
  bodyFile(directory: string, sessionId: string): string;
  resourceFile(directory: string, sessionId: string): string;
  sessionIdFromBodyFile(fileName: string): string;
}

/** Serialises a sync run against conversation writes. */
export interface SyncHistoryQueue {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/** The user-level state a sync run carries between machines besides the
 * conversation bodies. Kept separate from the index so a preferences conflict
 * can never damage a conversation. */
export interface SyncPreferences {
  pinned: string[];
  favorites: string[];
  titles: Record<string, string>;
  layout: ConversationLayout;
  selections: Record<string, AgentSelection>;
  drafts: Record<string, ComposerDraft>;
}

/** Host-side adapter: the sync engine never imports VS Code, so preferences
 * arrive as a plain snapshot and are written back through the caller. */
export interface SyncPreferenceBridge {
  read(): SyncPreferences;
  adopt(next: SyncPreferences): Promise<void>;
}

/** What one sync run moved. The controller turns this into a status message. */
export interface SyncOutcome {
  pulledSessions: number;
  pushedSessions: number;
  deletedSessions: number;
  copiedAttachments: number;
  copiedPlans: number;
  preferencesMerged: boolean;
}

export interface SyncSettings {
  directory: string;
  intervalSeconds: number;
  attachments: boolean;
}

export function syncChanged(outcome: SyncOutcome): boolean {
  return outcome.pulledSessions > 0
    || outcome.pushedSessions > 0
    || outcome.deletedSessions > 0
    || outcome.copiedAttachments > 0
    || outcome.copiedPlans > 0
    || outcome.preferencesMerged;
}
