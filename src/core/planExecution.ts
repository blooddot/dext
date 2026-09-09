import type { AgentStreamEvent, AgentTodoItem, PlanExecutionOutcome } from "./types.js";
import { PlanTodoProgress, planTodoInstruction } from "./planTodoProgress.js";

/** Completed tasks survive a resume only when their stable ID and text still match. */
export function resumePlanTodos(current: readonly AgentTodoItem[], previous: readonly AgentTodoItem[]): AgentTodoItem[] {
  return current.map((item) => {
    const prior = previous.find((candidate) => candidate.id === item.id && candidate.text === item.text);
    return { ...item, status: item.status === "completed" ? item.status : prior?.status ?? item.status };
  });
}

export class PlanExecution {
  readonly progress: PlanTodoProgress;
  rounds = 0;
  private stalled = 0;
  private readonly completed = new Set<string>();
  private readonly activity = new Set<string>();
  private novelActivity = false;
  constructor(items: readonly AgentTodoItem[], private readonly maxRounds = 64) {
    this.progress = new PlanTodoProgress(items);
    for (const item of items) if (item.status === "completed") this.completed.add(item.id);
  }
  get verifying(): boolean { const items = this.progress.snapshot(); return items.length > 0 && items.every((item) => item.status === "completed"); }
  beginRound(): void { this.rounds++; this.novelActivity = false; this.progress.beginRound(this.verifying); }
  observe(event: AgentStreamEvent): void {
    if (event.phase !== "tool") return;
    const key = `${event.title ?? ""}\n${event.text}`.slice(0, 4000);
    if (!key.trim() || this.activity.has(key)) return;
    this.novelActivity = true; this.activity.add(key);
    while (this.activity.size > 256) this.activity.delete(this.activity.values().next().value!);
  }
  finishRound(): PlanExecutionOutcome | undefined {
    const items = this.progress.snapshot();
    const remaining = items.filter((item) => item.status !== "completed");
    const end = (status: PlanExecutionOutcome["status"], reason: string): PlanExecutionOutcome => ({ status, reason, rounds: this.rounds });
    if (!items.length) return end("incomplete", "No trackable Tasks section was found. Plan completion could not be verified.");
    if (!remaining.length && this.progress.verified) return end("completed", "All tasks were reported complete and final verification passed.");
    const blocked = this.progress.blockers();
    if (remaining.length && blocked.length === remaining.length) return end("blocked", blocked.map((item) => `${item.id}: ${item.reason}`).join("\n"));
    const newCompleted = items.filter((item) => item.status === "completed" && !this.completed.has(item.id));
    for (const item of newCompleted) this.completed.add(item.id);
    this.stalled = newCompleted.length || this.novelActivity ? 0 : this.stalled + 1;
    if (this.stalled >= 3) return end("incomplete", "Stopped after three consecutive rounds without new completed tasks or new tool activity. Progress is saved; resume after reviewing the remaining work.");
    if (this.rounds >= this.maxRounds) return end("incomplete", `Stopped at the ${this.maxRounds}-round continuation limit. Progress is saved for an explicit resume.`);
    return undefined;
  }
  prompt(plan: string, latestAnswer = ""): string {
    return [plan, "", "Dext host continuation: the previous answer did not finish this plan.",
      this.verifying ? "FINAL VERIFICATION: audit the implementation and required checks. Reopen incomplete tasks; report verification=passed only after successful verification."
        : "Continue the remaining actionable tasks now. Do not repeat completed work. An external blocker for one task does not stop independent tasks.",
      planTodoInstruction(this.progress.snapshot()),
      `Recorded external blockers: ${JSON.stringify(this.progress.blockers())}`,
      `Previous round summary:\n${latestAnswer.slice(-12000)}`].join("\n");
  }
}
