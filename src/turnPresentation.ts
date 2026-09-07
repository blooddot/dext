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
