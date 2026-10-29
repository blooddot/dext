export const DEFAULT_AGENT_TIMEOUT_MS = 0;
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 600_000;
export const MAX_AGENT_TIMEOUT_MS = 2_147_483_647;

/** A tool that never reports a result would pause idle detection forever, so a
 * silent tool needs its own ceiling. shortcut: one ceiling for every provider
 * and no setting; add `dext.agent.toolTimeoutMs` if a legitimate tool needs
 * longer. */
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 1_800_000;

export interface AgentTimeout {
  activity: () => void;
  toolStarted: (id: string) => void;
  toolFinished: (id: string) => void;
  dispose: () => void;
}

/** A live turn can outlast the idle interval; output restarts the idle clock.
 * Reported tool execution pauses idle detection until every tool has ended,
 * so one continuous tool phase gets its own wall-clock ceiling. An explicitly
 * configured total limit remains independent of activity. */
export function agentTimeout(
  controller: AbortController,
  timeoutMs: number,
  idleTimeoutMs: number,
  toolTimeoutMs: number = DEFAULT_AGENT_TOOL_TIMEOUT_MS
): AgentTimeout {
  let disposed = false;
  const activeTools = new Set<string>();
  const completedTools = new Set<string>();
  const totalTimer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(
    `Agent execution timed out after ${timeoutMs} ms (total time limit; dext.agent.timeoutMs).`
  )), Math.min(timeoutMs, MAX_AGENT_TIMEOUT_MS)) : undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let toolTimer: ReturnType<typeof setTimeout> | undefined;
  const armTool = (): void => {
    if (disposed || toolTimer || toolTimeoutMs <= 0) return;
    toolTimer = setTimeout(() => controller.abort(new Error(
      `Agent execution timed out after ${toolTimeoutMs} ms inside one tool call (Dext's per-tool limit).`
    )), Math.min(toolTimeoutMs, MAX_AGENT_TIMEOUT_MS));
  };
  const armIdle = (): void => {
    if (disposed || activeTools.size || idleTimeoutMs <= 0) return;
    if (idleTimer) { idleTimer.refresh(); return; }
    idleTimer = setTimeout(() => controller.abort(new Error(
      `Agent execution timed out after ${idleTimeoutMs} ms without process activity (dext.agent.idleTimeoutMs).`
    )), Math.min(idleTimeoutMs, MAX_AGENT_TIMEOUT_MS));
  };
  armIdle();
  const dispose = (): void => {
    disposed = true;
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (toolTimer) clearTimeout(toolTimer);
    activeTools.clear();
    completedTools.clear();
    controller.signal.removeEventListener("abort", dispose);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  if (controller.signal.aborted) dispose();
  return {
    activity: armIdle,
    toolStarted: (id) => {
      if (disposed || !id || completedTools.has(id)) return;
      activeTools.add(id);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      armTool();
    },
    toolFinished: (id) => {
      if (disposed || !id) return;
      completedTools.add(id);
      if (!activeTools.delete(id) || activeTools.size) return;
      // Sequential tools each get the full ceiling; only one continuous tool
      // phase is bounded.
      if (toolTimer) clearTimeout(toolTimer);
      toolTimer = undefined;
      armIdle();
    },
    dispose
  };
}
