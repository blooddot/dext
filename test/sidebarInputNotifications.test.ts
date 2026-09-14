import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../src/core/types.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";
import type { DextHistorySession } from "../src/historyStore.js";
import { uiCallForm } from "../src/core/uiForm.js";

const host = vi.hoisted(() => ({ showInformationMessage: vi.fn(), executeCommand: vi.fn() }));
vi.mock("vscode", () => ({ window: host, commands: host }));
import { DextSidebarProvider } from "../src/sidebarProvider.js";

const waiting: AgentStreamEvent = {
  phase: "input", text: "", userInput: { id: "question", status: "waiting", blocking: false, questions: [] }
};

function harness() {
  let choose!: (action?: string) => void;
  host.showInformationMessage.mockImplementation(() => new Promise<string | undefined>((resolve) => { choose = resolve; }));
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider & {
    publish(sessionId: string, event: AgentStreamEvent): void;
    restore(sessionId: string): Promise<void>;
  };
  const session = { id: "background", turns: [] } as unknown as DextHistorySession;
  const messages: WebviewResponse[] = [];
  const post = vi.fn(async (message: WebviewResponse) => { messages.push(message); });
  const executions = new Map([[session.id, { turnId: "turn", source: "", mode: "agent", events: [waiting] }]]);
  Object.assign(sidebar, {
    activeSession: { id: "foreground" }, activeExecutions: executions,
    sessions: new Map([[session.id, session]]), post, postWhenReady: post,
    publish: Reflect.get(sidebar, "postAgentEvent"), restore: Reflect.get(sidebar, "postActiveExecution")
  });
  const open = vi.spyOn(sidebar, "openConversation").mockImplementation(async (next) => {
    Object.assign(sidebar, { activeSession: next });
    await sidebar.restore(next.id);
  });
  return { sidebar, choose: (action?: string) => choose(action), messages, open, executions };
}

describe("sidebar input notifications", () => {
  beforeEach(() => vi.resetAllMocks());

  it("notifies for background nonblocking questions, then restores before focusing", async () => {
    const h = harness();
    h.sidebar.publish("background", waiting);
    expect(host.showInformationMessage).toHaveBeenCalledOnce();
    expect(h.messages).toEqual([]);
    expect(h.open).not.toHaveBeenCalled();
    h.choose("View question");
    await vi.waitFor(() => expect(h.messages.at(-1)).toEqual({
      type: "focusAgentInput", sessionId: "background", turnId: "turn", requestId: "question", kind: "agent"
    }));
    expect(host.executeCommand).toHaveBeenCalledWith("dext.sidebar.focus");
    expect(h.messages.map((message) => message.type)).toEqual(["executing", "agentEvents", "focusAgentInput"]);
  });

  it("notifies for UI forms and ignores answered notifications", async () => {
    const h = harness();
    const uiInteraction = {
      sessionId: "background", turnId: "turn", requestId: "form", status: "waiting" as const,
      form: uiCallForm("confirm", { message: "Choice", presentation: "inline" })
    };
    h.sidebar.publish("background", { phase: "input", text: "", uiInteraction });
    h.sidebar.publish("background", { phase: "input", text: "", uiInteraction });
    expect(host.showInformationMessage).toHaveBeenCalledOnce();
    h.sidebar.publish("background", { phase: "input", text: "", uiInteraction: { ...uiInteraction, status: "closed" } });
    h.choose("View question");
    await Promise.resolve();
    expect(host.executeCommand).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("does not navigate if the turn ends while the sidebar is being revealed", async () => {
    const h = harness();
    host.executeCommand.mockImplementation(async () => { h.executions.clear(); });
    h.sidebar.publish("background", waiting);
    h.choose("View question");
    await vi.waitFor(() => expect(host.executeCommand).toHaveBeenCalled());
    expect(h.open).not.toHaveBeenCalled();
  });
});
