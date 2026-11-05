export type PlanStatus = "new" | "active" | "running" | "completed" | "failed";

export interface PlanToolbarElements {
  toolbar: HTMLElement;
  target: HTMLButtonElement;
  choose: HTMLButtonElement;
  targetLabel: HTMLElement;
  status: HTMLElement;
  build: HTMLButtonElement;
}

export interface PlanToolbarView {
  document: Document;
  elements: PlanToolbarElements;
  /** A resource draft owns the composer, so the plan toolbar steps aside. */
  hasResource(): boolean;
  inputMode(): string;
  activePlanPath(): string | undefined;
  planStatus(): PlanStatus;
  executing(): boolean;
  stopping(): boolean;
  activeTurnId(): string | undefined;
  /** A preset that runs outside the sandbox blocks a writable build turn. */
  buildRestriction(): string | undefined;
  /** A build this conversation already sent is still being prepared. Reading
   * the plan is an awaited step, so the wait can outlast the click. */
  preparingBuild(): boolean;
  onResourceActive(): void;
}

/** Renders the Plan toolbar from the current execution state. A plan cannot be
 * switched while its current turn is being edited or built, so the chooser and
 * Build stay in sync with what the host would accept. */
export function renderPlanToolbar(view: PlanToolbarView): void {
  const { elements } = view;
  if (view.hasResource()) {
    elements.toolbar.hidden = true;
    view.onResourceActive();
    return;
  }
  const visible = view.inputMode() === "plan";
  const activePlanPath = view.activePlanPath();
  const planStatus = view.planStatus();
  elements.toolbar.hidden = !visible;
  if (!visible) return;
  elements.targetLabel.textContent = activePlanPath?.split("/").pop() ?? "New plan";
  elements.target.title = activePlanPath ? `Open ${activePlanPath}` : "Select a plan (or hold Shift and drop a file)";
  const labels: Record<PlanStatus, string> = {
    new: "New plan",
    active: "Active",
    running: "Running",
    completed: "Completed",
    failed: "Failed"
  };
  elements.status.textContent = labels[planStatus];
  elements.status.title = "";
  elements.status.dataset.state = "";
  elements.status.hidden = !activePlanPath;
  elements.build.hidden = !activePlanPath;
  // Keep the chooser in sync with Build so the host never receives a
  // plan-selection request that it must reject because an execution is active.
  const planLocked = view.executing() || planStatus === "running";
  elements.choose.disabled = planLocked;
  // Opening the already-selected document remains useful while it runs. For a
  // new plan, the target button is itself a chooser and must be locked too.
  elements.target.disabled = planLocked && !activePlanPath;
  const planBuildRunning = planStatus === "running" && view.executing();
  // Preparing names the wait between the click and the first turn event. It is
  // its own state because neither Build nor Stop describes it: the host has
  // work in hand but no turn to stop yet. Re-rendering from unchanged host
  // state must keep showing it, or a tab switch makes Build look clickable
  // again while the build it already sent is still running.
  const preparingBuild = !planBuildRunning && view.preparingBuild();
  // Building runs a writable turn, so it applies the selected preset as-is; the
  // host rejects a preset that needs Full access when the tier is not selected.
  const buildRestriction = view.buildRestriction();
  elements.build.disabled = Boolean(buildRestriction) || (planBuildRunning
    ? view.stopping() || !view.activeTurnId()
    : preparingBuild || view.executing() || planStatus === "running" || !activePlanPath);
  elements.build.classList.toggle("executing", planBuildRunning);
  elements.build.classList.toggle("stopping", planBuildRunning && view.stopping());
  elements.build.classList.toggle("preparing", preparingBuild);
  elements.build.classList.remove("conflict");
  const buildLabel = elements.build.querySelector("span");
  if (buildLabel) buildLabel.textContent = planBuildRunning ? "Stop" : preparingBuild ? "Preparing…" : planStatus === "completed" ? "Rebuild" : "Build";
  elements.build.title = buildRestriction ?? (planBuildRunning
    ? view.stopping() ? "Stopping the active plan" : "Stop building the active plan"
    : preparingBuild ? "Dext is reading the plan before the turn starts"
    : planStatus === "completed" ? "Rebuild the active plan" : "Build the active plan");
  elements.build.setAttribute("aria-label", elements.build.title);
  const buildIcon = elements.build.querySelector<HTMLElement>("i");
  if (buildIcon) buildIcon.className = `codicon codicon-${planBuildRunning ? "debug-stop" : preparingBuild ? "loading codicon-modifier-spin" : "play"}`;
}

/** A plan result links back to its saved document for review or editing. */
export function planActions(
  document: Document,
  planPath: string,
  open: (reference: string) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plan-action";
  const glyph = document.createElement("i");
  glyph.className = "codicon codicon-checklist";
  const label = document.createElement("span");
  label.textContent = `Plan: ${planPath.split("/").pop() ?? planPath}`;
  button.title = `Open ${planPath}`;
  button.append(glyph, label);
  button.addEventListener("click", () => open(planPath));
  row.append(button);
  return row;
}
