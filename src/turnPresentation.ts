import { formatDuration } from "./webview/duration.js";

/** Shared labels and icons for the live conversation and History toolbars. */
export const TURN_EDIT_ACTION = { icon: "edit", label: "Edit input in Dext" } as const;
export const TURN_RENAME_ACTION = { icon: "rename", label: "Rename turn" } as const;
export const TURN_RETRY_ACTION = { icon: "debug-restart", label: "Retry this turn" } as const;
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

export function presentTurn(options: {
  source: string;
  mode?: TurnMode | undefined;
  hideInput?: boolean | undefined;
  durationMs?: number | undefined;
}): TurnRenderModel {
  const duration = options.durationMs;
  const detail = duration !== undefined && Number.isFinite(duration) && duration > 0
    ? `Worked for ${formatDuration(duration)}` : undefined;
  return {
    ...(options.hideInput ? {} : {
      input: { kind: "input", label: "Input", source: options.source, mode: presentTurnMode(options.mode) }
    }),
    process: { kind: "process", label: "Process", ...(detail ? { detail } : {}) },
    output: { kind: "output", label: "Output" }
  };
}

/** Keep a custom name through deferred Plan hydration and cached tab restores. */
export class TurnTitle {
  constructor(
    private readonly element: Pick<HTMLElement, "textContent">,
    private fallback: string,
    private name?: string
  ) {
    this.render();
  }

  rename(name: string | undefined, fallback: string): void {
    this.name = name;
    this.fallback = fallback;
    this.render();
  }

  setPlanPath(path: string): void {
    this.fallback = `Plan: ${path.split("/").pop() ?? path}`;
    this.render();
  }

  private render(): void {
    this.element.textContent = this.name || this.fallback;
  }
}
