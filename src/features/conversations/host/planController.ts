import { PlanExecution, resumePlanTodos } from "../domain/planExecution.js";
import { planAcceptanceItems, planTodoItems, planTodoInstruction, type PlanTodoProgress } from "../domain/planTodoProgress.js";
import { mergePlanAcceptance, togglePlanAcceptance } from "../domain/planAcceptance.js";
import type { AgentTodoItem, PlanAcceptanceItem, PlanExecutionOutcome } from "../../../shared/contracts/types.js";
import type { DextHistorySession, PlanStatus } from "../contracts/history.js";

/** The host capabilities plan work needs. Reading the actual file is a port so
 * the controller never touches `vscode.workspace.fs` directly. */
export interface PlanFileHost {
  isTrustedLocalWorkspace: () => boolean;
  /** Reads the plan the user is editing, not the text that started the turn. */
  readPlan: (planPath: string) => Promise<string>;
  /** True when the reference names a Dext plan this host can serve. */
  knownPlan: (reference: string) => boolean;
}

export interface PlanSessionPort {
  active: () => DextHistorySession;
  savePlanContext: (sessionId: string, path: string | undefined, status: PlanStatus) => Promise<void>;
  savePlanProgress: (sessionId: string, path: string, todos: readonly AgentTodoItem[], acceptance?: readonly PlanAcceptanceItem[]) => Promise<void>;
  postPlanContext: () => Promise<void>;
  /** Answers a user toggle with the state the host just persisted, so the panel
   * never keeps a checkbox the host rejected. */
  postPlanAcceptance: (sessionId: string, path: string, items: readonly PlanAcceptanceItem[]) => Promise<void>;
}

export interface PlanControllerOptions {
  host: PlanFileHost;
  sessions: PlanSessionPort;
  /** The turn currently running in a conversation, if any. */
  running: (sessionId: string) => boolean;
  /** Starts the plan turn through the execution coordinator. Injected because
   * plan building is a caller of execution, not an owner of it. */
  startTurn: (session: DextHistorySession, mode: "plan", source: string, planPath: string | undefined, executePlan: boolean) => Promise<void>;
}

/** What one plan-executing turn carries. Created when the turn starts and
 * discarded with it, so conversations cannot share rounds or task state. */
export interface PlanRunContext {
  executionPlanPath?: string;
  planRun?: PlanExecution;
  todoProgress?: PlanTodoProgress;
  /** The user's acceptance list for this run. It never feeds completion. */
  planAcceptance?: PlanAcceptanceItem[];
  planExecution?: { executePlan: boolean; planPath?: string; planOutcome?: PlanExecutionOutcome };
}

/** Plan files, progress and status. The turn loop stays in the execution
 * coordinator; this controller decides what the plan round should see. */
export class PlanController {
  /** The last acceptance state published per conversation, so a round that
   * writes tasks does not resend an unchanged list. */
  private readonly publishedAcceptance = new Map<string, string>();

  constructor(private readonly options: PlanControllerOptions) {}

  startRun(session: DextHistorySession, source: string, executePlan: boolean, executionPlanPath: string | undefined): PlanRunContext {
    if (!executePlan) return {};
    const previousPlan = [...session.turns].reverse().find((turn) => turn.executePlan && turn.planPath === executionPlanPath);
    const previousTodos = session.planProgress && session.planProgress.path === executionPlanPath
      ? session.planProgress.todos
      : previousPlan ? [...previousPlan.process].reverse().find((event) => event.phase === "todo")?.todos ?? [] : [];
    const planRun = new PlanExecution(resumePlanTodos(planTodoItems(source), previousTodos));
    // Acceptance identity is derived from the wording, so reordering the section
    // keeps each check on its own requirement.
    const storedAcceptance = session.planProgress && session.planProgress.path === executionPlanPath
      ? session.planProgress.acceptance ?? []
      : [];
    return {
      ...(executionPlanPath ? { executionPlanPath } : {}),
      planRun,
      todoProgress: planRun.progress,
      planAcceptance: mergePlanAcceptance(planAcceptanceItems(source), storedAcceptance),
      planExecution: { executePlan: true, ...(executionPlanPath ? { planPath: executionPlanPath } : {}) }
    };
  }

  /** Handing a plan to the Agent re-reads the file rather than trusting the
   * text from the turn, so edits the user made in the editor are what gets
   * built. The path comes from the webview, so it is checked before any read. */
  async build(planPath: string): Promise<void> {
    if (!this.options.host.isTrustedLocalWorkspace()) {
      throw new Error("Building a plan requires a trusted local workspace.");
    }
    let text: string;
    try {
      text = await this.options.host.readPlan(planPath);
    } catch {
      throw new Error(`Plan '${planPath}' is no longer available.`);
    }
    if (!text.trim()) throw new Error(`Plan '${planPath}' is empty.`);
    const session = this.options.sessions.active();
    if (this.options.running(session.id)) throw new Error("Stop the running turn before building a plan.");
    const previousStatus = session.planStatus ?? "active";
    session.activePlanPath = planPath;
    session.planStatus = "running";
    await this.options.sessions.savePlanContext(session.id, planPath, "running");
    await this.options.sessions.postPlanContext();
    try {
      // The turn starts in the conversation this Build was clicked in. The check
      // above awaits AI work, so a tab switch must not move the build elsewhere.
      await this.options.startTurn(session, "plan", [
        `Implement the plan in ${planPath} exactly as written. Do not edit the plan file itself.`,
        planTodoInstruction(planTodoItems(text)),
        "",
        text.trim()
      ].join("\n"), undefined, true);
    } catch (error) {
      // A start the coordinator rejected never took this plan; leaving the
      // status running would keep Build disabled with no turn behind it.
      if (!this.options.running(session.id)) {
        session.planStatus = previousStatus;
        await this.options.sessions.savePlanContext(session.id, planPath, previousStatus);
        await this.options.sessions.postPlanContext();
      }
      throw error;
    }
  }

  /** One click to revise the selected plan instead of the user rewriting it. */
  async correct(planPath: string): Promise<void> {
    if (!this.options.host.isTrustedLocalWorkspace()) {
      throw new Error("Correcting a plan requires a trusted local workspace.");
    }
    const session = this.options.sessions.active();
    if (this.options.running(session.id)) throw new Error("Stop the running turn before correcting a plan.");
    session.activePlanPath = planPath;
    await this.options.sessions.savePlanContext(session.id, planPath, session.planStatus ?? "active");
    await this.options.sessions.postPlanContext();
    await this.options.startTurn(session, "plan", [
      "Correct this plan so its tasks match what the codebase actually allows. Keep every task that is still valid.",
    ].join("\n"), planPath, false);
  }

  /** The plan the model wrote becomes the conversation's active target as soon
   * as the turn is stored. */
  async adoptGeneratedPlan(session: DextHistorySession, planPath: string): Promise<void> {
    session.activePlanPath = planPath;
    session.planStatus = "active";
    await this.options.sessions.savePlanContext(session.id, planPath, "active");
    await this.options.sessions.postPlanContext();
  }

  async saveProgress(
    session: DextHistorySession,
    executionPlanPath: string,
    todos: readonly AgentTodoItem[],
    seeded?: readonly PlanAcceptanceItem[]
  ): Promise<void> {
    // A round only reports tasks; the same plan's acceptance keeps its state, so
    // checks made while the turn runs survive each write. The first write of a
    // run falls back to the list the document seeded.
    const stored = session.planProgress?.path === executionPlanPath ? session.planProgress.acceptance : undefined;
    const acceptance = stored ?? seeded;
    session.planProgress = { path: executionPlanPath, todos: [...todos], ...(acceptance ? { acceptance: [...acceptance] } : {}) };
    await this.options.sessions.savePlanProgress(session.id, executionPlanPath, todos, acceptance);
    // The panel needs the seeded list before the run ends, so a user can start
    // confirming while a long plan is still working through its tasks.
    if (acceptance?.length) {
      const signature = JSON.stringify([executionPlanPath, acceptance]);
      if (this.publishedAcceptance.get(session.id) !== signature) {
        this.publishedAcceptance.set(session.id, signature);
        await this.options.sessions.postPlanAcceptance(session.id, executionPlanPath, acceptance);
      }
    }
  }

  /** Only the user can move acceptance, so this path validates the plan the
   * stored progress belongs to. `activePlanPath` is deliberately not used: it is
   * cleared when a plan completes, which is exactly when acceptance is checked. */
  async toggleAcceptance(planPath: string, itemId: string, checked: boolean): Promise<void> {
    const session = this.options.sessions.active();
    const progress = session.planProgress;
    if (!progress || progress.path !== planPath) {
      throw new Error(`Plan '${planPath}' has no saved acceptance list.`);
    }
    const items = progress.acceptance ?? [];
    if (!items.some((item) => item.id === itemId)) {
      throw new Error(`Acceptance item '${itemId}' is not part of this plan.`);
    }
    const next = togglePlanAcceptance(items, itemId, checked);
    session.planProgress = { path: progress.path, todos: progress.todos, acceptance: next };
    await this.options.sessions.savePlanProgress(session.id, planPath, progress.todos, next);
    this.publishedAcceptance.set(session.id, JSON.stringify([planPath, next]));
    await this.options.sessions.postPlanAcceptance(session.id, planPath, next);
  }

  /** A stopped plan keeps its progress; a completed one clears the target. */
  async settle(
    session: DextHistorySession,
    options: { outcome?: PlanExecutionOutcome; cancelled: boolean; failed: boolean }
  ): Promise<void> {
    if (session.planStatus !== "running") return;
    if (options.failed) session.planStatus = options.cancelled ? "active" : "failed";
    else if (options.outcome?.status === "completed") {
      delete session.activePlanPath;
      session.planStatus = "new";
    } else session.planStatus = "active";
    await this.options.sessions.savePlanContext(session.id, session.activePlanPath, session.planStatus);
    await this.options.sessions.postPlanContext();
  }

  async setActivePlan(reference: string | undefined): Promise<void> {
    const session = this.options.sessions.active();
    if (this.options.running(session.id)) throw new Error("Stop the running turn before changing the active plan.");
    if (reference) {
      if (!this.options.host.knownPlan(reference)) throw new Error(`'${reference}' is not a Dext plan file.`);
      session.activePlanPath = reference;
      session.planStatus = "active";
    } else {
      delete session.activePlanPath;
      session.planStatus = "new";
    }
    await this.options.sessions.savePlanContext(session.id, session.activePlanPath, session.planStatus ?? "new");
    await this.options.sessions.postPlanContext();
  }
}
