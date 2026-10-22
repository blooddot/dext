import { PlanExecution, resumePlanTodos } from "../domain/planExecution.js";
import { planTodoItems, planTodoInstruction, type PlanTodoProgress } from "../domain/planTodoProgress.js";
import type { AgentTodoItem, PlanExecutionOutcome } from "../../../shared/contracts/types.js";
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
  savePlanProgress: (sessionId: string, path: string, todos: readonly AgentTodoItem[]) => Promise<void>;
  postPlanContext: () => Promise<void>;
}

export interface PlanControllerOptions {
  host: PlanFileHost;
  sessions: PlanSessionPort;
  /** The turn currently running in a conversation, if any. */
  running: (sessionId: string) => boolean;
  /** Starts the plan turn through the execution coordinator. Injected because
   * plan building is a caller of execution, not an owner of it. */
  startTurn: (mode: "plan", source: string, planPath: string | undefined, executePlan: boolean) => Promise<void>;
}

/** What one plan-executing turn carries. Created when the turn starts and
 * discarded with it, so conversations cannot share rounds or task state. */
export interface PlanRunContext {
  executionPlanPath?: string;
  planRun?: PlanExecution;
  todoProgress?: PlanTodoProgress;
  planExecution?: { executePlan: boolean; planPath?: string; planOutcome?: PlanExecutionOutcome };
}

/** Plan files, progress and status. The turn loop stays in the execution
 * coordinator; this controller decides what the plan round should see. */
export class PlanController {
  constructor(private readonly options: PlanControllerOptions) {}

  startRun(session: DextHistorySession, source: string, executePlan: boolean, executionPlanPath: string | undefined): PlanRunContext {
    if (!executePlan) return {};
    const previousPlan = [...session.turns].reverse().find((turn) => turn.executePlan && turn.planPath === executionPlanPath);
    const previousTodos = session.planProgress && session.planProgress.path === executionPlanPath
      ? session.planProgress.todos
      : previousPlan ? [...previousPlan.process].reverse().find((event) => event.phase === "todo")?.todos ?? [] : [];
    const planRun = new PlanExecution(resumePlanTodos(planTodoItems(source), previousTodos));
    return {
      ...(executionPlanPath ? { executionPlanPath } : {}),
      planRun,
      todoProgress: planRun.progress,
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
    session.activePlanPath = planPath;
    session.planStatus = "running";
    await this.options.sessions.savePlanContext(session.id, planPath, "running");
    await this.options.sessions.postPlanContext();
    await this.options.startTurn("plan", [
      `Implement the plan in ${planPath} exactly as written. Do not edit the plan file itself.`,
      planTodoInstruction(planTodoItems(text)),
      "",
      text.trim()
    ].join("\n"), undefined, true);
  }

  /** The plan the model wrote becomes the conversation's active target as soon
   * as the turn is stored. */
  async adoptGeneratedPlan(session: DextHistorySession, planPath: string): Promise<void> {
    session.activePlanPath = planPath;
    session.planStatus = "active";
    await this.options.sessions.savePlanContext(session.id, planPath, "active");
    await this.options.sessions.postPlanContext();
  }

  async saveProgress(session: DextHistorySession, executionPlanPath: string, todos: readonly AgentTodoItem[]): Promise<void> {
    session.planProgress = { path: executionPlanPath, todos: [...todos] };
    await this.options.sessions.savePlanProgress(session.id, executionPlanPath, todos);
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
