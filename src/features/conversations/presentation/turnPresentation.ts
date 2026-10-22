import { formatDuration } from "../../../shared/lib/duration.js";
import type { AgentStreamEvent, AgentTokenUsage } from "../../../shared/contracts/types.js";

/** Shared labels and icons for the live conversation and History toolbars. */
export const TURN_EDIT_ACTION = { icon: "edit", label: "Edit input in Dext" } as const;
export const TURN_RENAME_ACTION = { icon: "rename", label: "Rename turn" } as const;
export const TURN_RETRY_ACTION = { icon: "debug-restart", label: "Retry this turn" } as const;
export const TURN_CONTINUE_ACTION = { icon: "play-circle", label: "Continue from the failed Code step" } as const;
export const TURN_FORK_ACTION = { icon: "repo-forked", label: "Fork from this turn" } as const;
export const TURN_COPY_ACTION = { icon: "copy", label: "Copy turn as Markdown" } as const;
export const TURN_DELETE_ACTION = { icon: "trash", label: "Delete turn from Dext" } as const;
export const TURN_DELETE_CONFIRMATION = "Delete this turn from Dext?";
export const DELETE_CONFIRMATION_DETAIL = "Only Dext's saved records are removed. CLI sessions and messages are kept, and continuing may still use that context. File changes are not undone.";
export const TURN_RETRY_CONFIRMATION = "Retry this turn? Any write actions may run again.";

export type TurnMode = "agent" | "ask" | "plan" | "code";

export function turnModeLabel(mode?: TurnMode): string {
  return mode ? { agent: "Agent", ask: "Ask", plan: "Plan", code: "Code" }[mode] : "Unknown";
}

/** A display-ready mode chip shared by the static History and live Conversation renderers. */
export interface TurnModePresentation {
  value: TurnMode | "unknown";
  label: string;
  title: string;
}

export function presentTurnMode(mode?: TurnMode): TurnModePresentation {
  return {
    value: mode ?? "unknown",
    label: turnModeLabel(mode),
    title: mode ? `Submitted in ${turnModeLabel(mode)} mode` : "Mode was not recorded for this turn"
  };
}

export type TurnSectionKind = "input" | "process" | "output";

/** The common immutable shape of the three turn sections.
 *
 * History renders this model to safe HTML in the extension host, while the
 * Conversation renders it to DOM and then adds live stream state. Keeping the
 * state-free part here prevents their section labels, mode chips, and timing
 * policy from drifting apart. */
export interface TurnInputPresentation {
  kind: "input";
  label: "Input";
  source: string;
  mode: TurnModePresentation;
}

export type TurnSectionPresentation = TurnInputPresentation
  | { kind: "process"; label: "Process"; detail?: string }
  | { kind: "output"; label: "Output" };

export interface TurnRenderModel {
  input?: TurnInputPresentation;
  process: TurnSectionPresentation & { kind: "process"; label: "Process" };
  output: TurnSectionPresentation & { kind: "output"; label: "Output" };
}

/** Use the same provider-reported count during streaming and after replay. */
function compactTokenCount(value: number): string {
  const scaled = value >= 1_000_000 ? { size: value / 1_000_000, suffix: "M" }
    : value >= 1_000 ? { size: value / 1_000, suffix: "k" }
      : { size: value, suffix: "" };
  const digits = scaled.suffix && scaled.size < 10 ? 1 : 0;
  return `${scaled.size.toFixed(digits).replace(/\.0$/, "")}${scaled.suffix}`;
}

export function formatTurnTokenUsage(usage?: AgentTokenUsage): string {
  const total = usage?.totalTokens
    ?? (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens : undefined);
  if (total !== undefined && Number.isFinite(total) && total >= 0) return `${compactTokenCount(total)} tokens`;
  // ACP (DeepSeek Harness) reports context occupancy instead of billed usage.
  // Keep that distinction in the label rather than passing it off as a charge.
  const context = usage?.contextTokens;
  if (context === undefined || !Number.isFinite(context) || context < 0) return "";
  const window = usage?.contextWindowTokens;
  return window !== undefined && Number.isFinite(window) && window > 0
    ? `${compactTokenCount(context)}/${compactTokenCount(window)} context`
    : `${compactTokenCount(context)} context`;
}

/** Usage events are snapshots. A snapshot that reports billed counts replaces
 * the previous billed report; a context-only ACP update merges in so it cannot
 * erase a billed count that arrived earlier in the same turn. */
export function updateTurnTokenUsage(previous: AgentTokenUsage | undefined, next: AgentTokenUsage): AgentTokenUsage {
  const billed = next.totalTokens !== undefined || next.inputTokens !== undefined
    || next.outputTokens !== undefined || next.cachedInputTokens !== undefined;
  return billed ? next : { ...previous, ...next };
}

export function presentTurn(options: {
  source: string;
  mode?: TurnMode | undefined;
  hideInput?: boolean | undefined;
  durationMs?: number | undefined;
  process?: readonly AgentStreamEvent[] | undefined;
}): TurnRenderModel {
  const duration = options.durationMs;
  const timing = duration !== undefined && Number.isFinite(duration) && duration > 0
    ? `Worked for ${formatDuration(duration)}` : "";
  // Usage events are snapshots, just like the live header: keep the latest
  // report instead of adding repeated updates or cached input a second time.
  let usage: AgentTokenUsage | undefined;
  for (const event of options.process ?? []) {
    if (event.usage) usage = updateTurnTokenUsage(usage, event.usage);
  }
  const detail = [timing, formatTurnTokenUsage(usage)].filter(Boolean).join(" · ");
  return {
    ...(options.hideInput ? {} : {
      input: { kind: "input", label: "Input", source: options.source, mode: presentTurnMode(options.mode) }
    }),
    process: { kind: "process", label: "Process", ...(detail ? { detail } : {}) },
    output: { kind: "output", label: "Output" }
  };
}

