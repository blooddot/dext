import type { AgentStreamEvent } from "../shared/contracts/types.js";
import type { SidebarState, WebviewRequest } from "../platform/webviewProtocol.js";
import { formatDuration } from "../shared/lib/duration.js";

export interface McpAssistantElements {
  dialog: HTMLDialogElement;
  close: HTMLButtonElement;
  input: HTMLTextAreaElement;
  status: HTMLElement;
  process: HTMLDetailsElement;
  processMeta: HTMLElement;
  processBody: HTMLElement;
  tools: HTMLElement;
  preview: HTMLTextAreaElement;
  scope: HTMLSelectElement;
  scopeLabel: HTMLElement;
  generate: HTMLButtonElement;
  save: HTMLButtonElement;
}

export interface McpAssistantHost {
  elements: McpAssistantElements;
  post: (message: WebviewRequest) => void;
  /** Opening the dialog closes any composer menu that was left open. */
  beforeOpen: () => void;
}

/** The Add MCP dialog: its own generation request, trace and tool allowlist. It
 * is not a conversation turn, so its running state never reaches the composer. */
export class McpAssistantView {
  private requestId: string | undefined;
  private runningRequestId: string | undefined;
  private stopping = false;
  private server: SidebarState["mcpServers"][number] | undefined;
  private processStartedAt: number | undefined;
  private processCount = 0;
  private processTokens: number | undefined;
  private pendingTools: string[] | undefined;

  constructor(private readonly host: McpAssistantHost) {}

  /** True while this dialog owns a generation the host must abort first. */
  get busy(): boolean {
    return this.runningRequestId !== undefined;
  }

  open(): void {
    this.host.beforeOpen();
    if (!this.host.elements.dialog.open) this.host.elements.dialog.showModal();
    this.updateAction();
    this.host.elements.input.focus();
  }

  /** Closing while generation is active must go through the same cancellation
   * path as the visible Stop button. The dialog stays open until the host
   * confirms the abort with an `executing: false` message. */
  requestClose(): void {
    if (this.runningRequestId) { this.generate(); return; }
    if (this.host.elements.dialog.open) this.host.elements.dialog.close();
  }

  /** Whether an `executing` message belongs to this dialog's generation. */
  owns(turnId: string | undefined, value: boolean | undefined): boolean {
    return turnId === this.runningRequestId || Boolean(value && turnId === this.requestId);
  }

  /** Applies an `executing` message; false means it is a conversation turn. */
  updateExecution(turnId: string | undefined, value: boolean | undefined): boolean {
    // MCP manifest generation has its own action in the MCP dialog. It must not
    // change the composer run control or create a phantom output entry.
    if (turnId !== this.runningRequestId && !(!this.runningRequestId && turnId === this.requestId && value)) return false;
    if (value) {
      this.runningRequestId = turnId;
      this.stopping = false;
    } else {
      this.runningRequestId = undefined;
      this.host.elements.process.open = false;
    }
    this.updateAction();
    return true;
  }

  progress(requestId: string, event: AgentStreamEvent): void {
    if (requestId !== this.requestId) return;
    const { elements } = this.host;
    if (event.phase === "todo") return;
    if (!this.processStartedAt) this.processStartedAt = Date.now();
    this.processCount += 1;
    const usage = event.usage;
    if (usage) {
      this.processTokens = usage.totalTokens
        ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
          ? usage.inputTokens + usage.outputTokens
          : this.processTokens);
    }
    elements.process.hidden = false;
    const elapsed = Math.max(0, Date.now() - this.processStartedAt);
    const tokenLabel = this.processTokens === undefined ? "" : ` · ${this.processTokens} tokens`;
    elements.processMeta.textContent = `Worked for ${formatDuration(elapsed)} · ${this.processCount} events${tokenLabel}`;
    if (event.phase === "status" && !event.text.trim()) return;
    const row = document.createElement("div");
    row.className = `mcp-process-event mcp-process-${event.phase}`;
    const title = document.createElement("strong");
    title.textContent = event.title || (event.phase === "tool" ? "Tool" : event.phase[0]!.toUpperCase() + event.phase.slice(1));
    const text = document.createElement("div");
    text.textContent = event.text;
    row.append(title, text);
    elements.processBody.append(row);
    elements.processBody.scrollTop = elements.processBody.scrollHeight;
  }

  toolsDiscovered(requestId: string, tools: Array<{ name: string; description?: string }>): void {
    if (requestId !== this.requestId) return;
    this.renderToolChoices(tools);
  }

  generated(requestId: string, server: SidebarState["mcpServers"][number]): void {
    if (requestId !== this.requestId) return;
    const { elements } = this.host;
    this.server = server;
    elements.preview.value = JSON.stringify(server, null, 2);
    elements.preview.hidden = false;
    elements.scope.hidden = false;
    elements.scopeLabel.hidden = false;
    elements.generate.hidden = true;
    elements.save.hidden = false;
    // Tool discovery follows generation; keep Save disabled until the
    // allowlist view has been populated.
    elements.save.disabled = true;
    // Completed Conversation Process sections are collapsed by default; keep
    // the MCP trace available on demand as well.
    elements.process.open = false;
    const elapsed = this.processStartedAt ? Math.max(0, Date.now() - this.processStartedAt) : 0;
    const tokenLabel = this.processTokens === undefined ? "" : ` · ${this.processTokens} tokens`;
    elements.processMeta.textContent = `Worked for ${formatDuration(elapsed)} · ${this.processCount} events${tokenLabel}`;
    elements.status.textContent = "Review the draft, choose where to save it, then confirm.";
  }

  created(name: string): void {
    this.host.elements.status.textContent = `MCP '${name}' was added and its tools are ready.`;
    this.host.elements.dialog.close();
  }

  fail(message: string): void {
    const { elements } = this.host;
    if (!elements.dialog.open) return;
    elements.status.textContent = message;
    this.updateAction();
    elements.save.disabled = false;
  }

  private resetProcess(): void {
    const { elements } = this.host;
    this.processStartedAt = undefined;
    this.processCount = 0;
    this.processTokens = undefined;
    this.pendingTools = undefined;
    elements.processBody.replaceChildren();
    elements.processMeta.textContent = "";
    elements.process.hidden = true;
    elements.process.open = false;
    elements.tools.replaceChildren();
    elements.tools.hidden = true;
  }

  private updateAction(): void {
    // MCP generation is presented in its own dialog. Keep its Stop state
    // independent from the conversation composer run control.
    const { elements } = this.host;
    const closeLabel = this.runningRequestId
      ? this.stopping ? "Stopping MCP generation" : "Stop MCP generation"
      : "Close MCP Assistant";
    elements.close.title = closeLabel;
    elements.close.setAttribute("aria-label", closeLabel);
    const closeIcon = elements.close.querySelector<HTMLElement>("i");
    if (closeIcon) closeIcon.className = `codicon codicon-${this.runningRequestId ? "debug-stop" : "close"}`;
    if (this.runningRequestId) {
      elements.generate.hidden = false;
      elements.generate.disabled = this.stopping;
      elements.generate.textContent = this.stopping ? "Stopping" : "Stop";
      elements.generate.classList.toggle("stopping", this.stopping);
      return;
    }
    elements.generate.disabled = false;
    elements.generate.textContent = "Generate";
    elements.generate.classList.remove("stopping");
  }

  generate(): void {
    const { elements } = this.host;
    if (this.runningRequestId) {
      if (this.stopping) return;
      this.stopping = true;
      elements.status.textContent = "Stopping MCP generation…";
      this.host.post({ type: "stopExecution", turnId: this.runningRequestId });
      this.updateAction();
      return;
    }
    const documentText = elements.input.value.trim();
    if (!documentText) { elements.status.textContent = "Paste a documentation or registry URL first."; return; }
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.requestId = requestId;
    // Mark the request busy immediately, before the host's executing event
    // comes back. This closes the small race where a fast click on X/Esc could
    // dismiss the dialog while generation was already in flight.
    this.runningRequestId = requestId;
    this.stopping = false;
    elements.status.textContent = "Dext is reading the documentation and drafting a safe configuration…";
    this.resetProcess();
    elements.process.hidden = false;
    elements.process.open = true;
    this.processStartedAt = Date.now();
    this.updateAction();
    this.host.post({ type: "generateMcp", requestId, document: documentText });
  }

  save(): void {
    const { elements } = this.host;
    if (!this.server) return;
    let value: unknown;
    try { value = JSON.parse(elements.preview.value); } catch { elements.status.textContent = "Configuration must be valid JSON."; return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { elements.status.textContent = "Configuration must be a JSON object."; return; }
    const server = value as Record<string, unknown>;
    if ((server.transport !== "http" && server.transport !== "stdio") || typeof server.name !== "string") {
      elements.status.textContent = "Configuration needs a name and a supported transport."; return;
    }
    const rawAuth = server.auth && typeof server.auth === "object" ? server.auth as Record<string, unknown> : undefined;
    if (rawAuth?.type === "query" && (typeof rawAuth.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rawAuth.name))) {
      elements.status.textContent = "Query authentication needs a parameter name such as 'key'.";
      return;
    }
    const httpAuth = rawAuth?.type === "query"
      ? { type: "query" as const, name: rawAuth.name as string }
      : rawAuth ? { type: "bearer" as const } : undefined;
    const candidate = server.transport === "http"
      ? { name: server.name, transport: "http" as const, url: typeof server.url === "string" ? server.url : "", ...(httpAuth ? { auth: httpAuth } : {}) }
      : {
        name: server.name,
        transport: "stdio" as const,
        command: typeof server.command === "string" ? server.command : "",
        ...(Array.isArray(server.args) ? { args: server.args.filter((item): item is string => typeof item === "string") } : {}),
        ...(server.auth && typeof server.auth === "object" && (server.auth as Record<string, unknown>).type === "token"
          && typeof (server.auth as Record<string, unknown>).env === "string"
          ? { auth: { type: "token" as const, env: (server.auth as Record<string, unknown>).env as string } }
          : {})
      };
    if (this.pendingTools === undefined) {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this.requestId = requestId;
      this.host.post({ type: "prepareMcp", requestId, scope: elements.scope.value as "project" | "global", server: candidate });
      elements.status.textContent = "Discovering MCP tools…";
      elements.save.disabled = true;
      return;
    }
    this.host.post({ type: "createMcp", scope: elements.scope.value as "project" | "global", selectedTools: this.pendingTools, server: candidate });
    elements.status.textContent = "MCP saved. Refreshing its tools…";
    elements.save.disabled = true;
  }

  private renderToolChoices(tools: Array<{ name: string; description?: string }>): void {
    const { elements } = this.host;
    this.pendingTools = tools.map((tool) => tool.name);
    elements.tools.replaceChildren();
    elements.tools.hidden = false;
    const heading = document.createElement("div");
    heading.className = "mcp-assistant-label";
    heading.textContent = `Select tools to add (${tools.length})`;
    elements.tools.append(heading);
    for (const tool of tools) {
      const label = document.createElement("label");
      label.className = "mcp-tool-choice";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = true;
      input.addEventListener("change", () => {
        if (!this.pendingTools) return;
        this.pendingTools = input.checked
          ? [...new Set([...this.pendingTools, tool.name])]
          : this.pendingTools.filter((name) => name !== tool.name);
      });
      const text = document.createElement("span");
      text.textContent = tool.name;
      const description = document.createElement("small");
      description.textContent = tool.description ?? "";
      label.append(input, text, description);
      elements.tools.append(label);
    }
    elements.status.textContent = "Choose the tools to include, then save MCP.";
    elements.save.disabled = false;
  }
}
