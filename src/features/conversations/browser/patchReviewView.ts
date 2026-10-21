import type { PatchChange, WorkflowStepResponse } from "../../../core/types.js";
import { presentDiff } from "../presentation/diffPresentation.js";

export type DiffMode = "inline" | "split";
export type PatchResolutionStatus = "applied" | "rejected" | "conflict" | "unchanged";

export interface PatchReviewHost {
  document: Document;
  /** The conversation result container that owns every pending review entry. */
  root(): HTMLElement;
  /** The output body of the turn currently receiving results, if any. */
  activeOutput(): HTMLElement | undefined;
  /** Ask the host to write or drop the proposed files. Nothing is written until
   * the reader presses one of these buttons. */
  resolve(turnId: string, uris: readonly string[], accept: boolean): void;
}

/**
 * Renders diffs and the review controls for proposed file changes. The view
 * owns only DOM and the reader's diff-layout preference; applying a patch stays
 * an explicit host call so a proposal cannot reach the workspace by rendering.
 */
export class PatchReviewView {
  diffMode: DiffMode = "inline";

  constructor(private readonly host: PatchReviewHost) {}

  setDiffMode(container: HTMLElement, mode: DiffMode): void {
    const view = container.querySelector<HTMLElement>(".diff-view");
    if (view) view.dataset.diffView = mode;
    container.querySelectorAll<HTMLButtonElement>(".diff-mode-button").forEach((button) => {
      const active = button.dataset.diffMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  diffModeSwitch(container: HTMLElement): HTMLElement {
    const control = this.host.document.createElement("span");
    control.className = "diff-mode-switch";
    control.setAttribute("role", "group");
    control.setAttribute("aria-label", "Diff layout");
    for (const [mode, label] of [["inline", "Inline"], ["split", "Split"]] as const) {
      const button = this.host.document.createElement("button");
      button.type = "button";
      button.className = `diff-mode-button${mode === this.diffMode ? " active" : ""}`;
      button.dataset.diffMode = mode;
      button.title = `${label} diff`;
      button.textContent = label;
      button.setAttribute("aria-pressed", String(mode === this.diffMode));
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setDiffMode(container, mode);
      });
      control.append(button);
    }
    return control;
  }

  private diffSide(line: ReturnType<typeof presentDiff>["rows"][number]["before"], marker: string): HTMLElement {
    const { document } = this.host;
    const side = document.createElement("span");
    side.className = `diff-side ${line?.kind ?? "empty"}`;
    const lineNumber = document.createElement("span");
    lineNumber.className = "diff-line-number";
    lineNumber.textContent = line ? String(line.line) : "";
    const sign = document.createElement("span");
    sign.className = "diff-marker";
    sign.textContent = line ? marker : "";
    const code = document.createElement("span");
    code.className = "diff-code";
    code.textContent = line?.text ?? "";
    side.append(lineNumber, sign, code);
    return side;
  }

  appendDiffView(container: HTMLElement, change: PatchChange): void {
    const { document } = this.host;
    const presentation = presentDiff(change);
    const view = document.createElement("div");
    view.className = "diff-view";
    view.dataset.diffView = "inline";
    const inline = document.createElement("div");
    inline.className = "diff-inline";
    const split = document.createElement("div");
    split.className = "diff-split";
    for (const row of presentation.rows) {
      if (row.before?.kind === "context") inline.append(this.diffSide(row.before, " "));
      else {
        if (row.before) inline.append(this.diffSide(row.before, "-"));
        if (row.after) inline.append(this.diffSide(row.after, "+"));
      }
      const splitRow = document.createElement("span");
      splitRow.className = "diff-split-row";
      splitRow.append(
        this.diffSide(row.before, row.before?.kind === "removed" ? "-" : " "),
        this.diffSide(row.after, row.after?.kind === "added" ? "+" : " ")
      );
      split.append(splitRow);
    }
    view.dataset.diffView = this.diffMode;
    view.append(inline, split);
    container.append(view);
  }

  fileChangeDisclosure(
    change: PatchChange,
    className = "agent-file-change",
    reviewTurnId?: string
  ): HTMLDetailsElement {
    const { document } = this.host;
    const disclosure = document.createElement("details");
    disclosure.className = className;
    disclosure.dataset.diffContainer = "";
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const name = change.uri.replaceAll("\\", "/").split("/").pop() ?? change.uri;
    const counts = presentDiff(change);
    const label = document.createElement("span");
    label.textContent = name;
    const count = document.createElement("span");
    count.className = "diff-count";
    count.innerHTML = `<span class="diff-added">+${counts.added}</span> <span class="diff-removed">-${counts.removed}</span>`;
    const path = document.createElement("div");
    path.className = "agent-file-path";
    path.textContent = change.uri;
    summary.append(chevron, label, count, this.diffModeSwitch(disclosure));
    if (reviewTurnId) {
      disclosure.dataset.reviewUri = change.uri;
      summary.append(this.actions(reviewTurnId, [change.uri]));
    }
    disclosure.append(summary, path);
    this.appendDiffView(disclosure, change);
    return disclosure;
  }

  /** Nothing has been written yet at this point, so the buttons are the only way
   * the change reaches the workspace. */
  actions(turnId: string, uris: readonly string[], suffix = ""): HTMLElement {
    const { document } = this.host;
    const row = document.createElement("span");
    row.className = "patch-review-actions";
    const button = (
      icon: string,
      label: string,
      accept: boolean,
      variant: string
    ): HTMLButtonElement => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `patch-review-action ${variant}`;
      element.title = label;
      element.setAttribute("aria-label", label);
      const glyph = document.createElement("i");
      glyph.className = `codicon codicon-${icon}`;
      const text = document.createElement("span");
      text.textContent = label;
      element.append(glyph, text);
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        for (const sibling of row.querySelectorAll("button")) sibling.disabled = true;
        this.host.resolve(turnId, [...uris], accept);
      });
      return element;
    };
    row.append(
      button("check", `Accept${suffix}`, true, "accept"),
      button("close", `Reject${suffix}`, false, "reject")
    );
    return row;
  }

  /** A resolved file stops being a proposal, so its entry either reports what
   * happened or steps aside. A conflict stays reviewable on purpose. */
  applyResolution(
    turnId: string,
    uris: readonly string[],
    status: PatchResolutionStatus,
    message: string
  ): void {
    const root = this.host.root();
    for (const uri of uris) {
      for (const entry of root.querySelectorAll<HTMLDetailsElement>("details[data-review-uri]")) {
        if (entry.dataset.reviewUri !== uri) continue;
        const actions = entry.querySelector<HTMLElement>(".patch-review-actions");
        if (status === "conflict") {
          for (const button of actions?.querySelectorAll("button") ?? []) button.disabled = false;
          entry.classList.add("patch-conflict");
          continue;
        }
        entry.open = false;
        delete entry.dataset.reviewUri;
        entry.classList.remove("patch-conflict");
        entry.classList.add(status === "rejected" ? "patch-rejected" : "patch-applied");
        actions?.replaceWith(this.outcome(status));
      }
    }
    const all = root.querySelector<HTMLElement>(`[data-review-all="${turnId}"]`);
    if (all) {
      if (root.querySelector("details[data-review-uri]")) {
        for (const button of all.querySelectorAll("button")) button.disabled = false;
      } else {
        all.remove();
      }
    }
    if (status === "conflict") this.appendNotice(message);
  }

  /** A conflict is reported beside the changes rather than through the error
   * renderer, which clears the turn it is called on. */
  appendNotice(message: string): void {
    const target = this.host.activeOutput() ?? this.host.root();
    const existing = target.querySelector(".patch-review-notice");
    if (existing) existing.remove();
    const notice = this.host.document.createElement("div");
    notice.className = "patch-review-notice";
    notice.textContent = message;
    target.append(notice);
  }

  outcome(status: "applied" | "rejected" | "unchanged"): HTMLElement {
    const { document } = this.host;
    const outcome = document.createElement("span");
    outcome.className = `patch-review-outcome ${status}`;
    const glyph = document.createElement("i");
    glyph.className = `codicon codicon-${status === "rejected" ? "circle-slash" : "check-all"}`;
    const label = document.createElement("span");
    label.textContent = status === "rejected" ? "Rejected" : status === "unchanged" ? "No change" : "Accepted";
    outcome.append(glyph, label);
    return outcome;
  }

  /** Reviewing file by file is the careful path, so a single row covers the common
   * case of taking or dropping the whole proposal. */
  header(turnId: string, entries: readonly WorkflowStepResponse[]): HTMLElement {
    const files = new Set<string>();
    for (const step of entries) {
      const result = step.response?.result;
      if (result?.kind !== "agent") continue;
      for (const change of result.patch?.changes ?? []) files.add(change.uri);
    }
    const header = this.host.document.createElement("div");
    header.className = "patch-review-header";
    header.dataset.reviewAll = turnId;
    const label = this.host.document.createElement("span");
    label.className = "patch-review-label";
    label.textContent = `${files.size} file${files.size === 1 ? "" : "s"} awaiting review`;
    // An empty uri list is the host's signal to take every pending file, so the
    // row keeps working after some files have already been resolved.
    header.append(label, this.actions(turnId, [], " all"));
    return header;
  }
}
