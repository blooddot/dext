import { DEXT_APPEARANCE_KEY, isDextAppearance, type DextAppearance } from "../../shared/contracts/appearance.js";

/** The slice of `vscode.Memento` the controller needs, kept structural so host
 * tests can persist into an in-memory object instead of launching VS Code. */
export interface AppearanceMemento {
  get(section: string, defaultValue?: unknown): unknown;
  update(section: string, value: unknown): Thenable<void>;
}

export interface AppearanceDisposable {
  dispose(): void;
}

/**
 * One appearance decision for the whole extension. The sidebar, History and every
 * Project/resource editor tab are separate webview documents, so the choice lives
 * in `globalState` here and is broadcast; a per-document `localStorage` value would
 * let one surface switch while the others stayed on the previous palette.
 */
export class DextAppearanceController {
  private readonly listeners = new Set<(theme: DextAppearance) => void>();
  private value: DextAppearance;

  constructor(private readonly state: AppearanceMemento) {
    const stored = state.get(DEXT_APPEARANCE_KEY, "auto");
    this.value = isDextAppearance(stored) ? stored : "auto";
  }

  get current(): DextAppearance {
    return this.value;
  }

  async set(theme: DextAppearance): Promise<void> {
    if (!isDextAppearance(theme)) return;
    if (theme === this.value) return;
    this.value = theme;
    // Notify before awaiting persistence: the click already painted in the
    // sending webview, and the other documents should not trail behind a disk
    // write. A failed write leaves this session usable and the next successful
    // change persists again.
    for (const listener of [...this.listeners]) listener(theme);
    await this.state.update(DEXT_APPEARANCE_KEY, theme);
  }

  onDidChange(listener: (theme: DextAppearance) => void): AppearanceDisposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
}
