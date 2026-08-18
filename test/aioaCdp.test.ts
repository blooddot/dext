import { describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../src/agentProfiles.js";
import {
  AioaCdpAgentRunner,
  aioaApiDefinition,
  aioaBootstrapPrompt,
  aioaExecutionPrompt,
  aioaInputType,
  aioaLaunchArguments,
  aioaOutputType,
  aioaRequestPayload,
  aioaTurnPrompt,
  DefaultAioaCdpConnection,
  defaultAioaExecutable,
  normalizeAioaCdpEndpoint,
  normalizeAioaWorkspaceName,
  openAioaWorkspaceConversation,
  parseJsonOutput,
  replaceAioaText,
  resolveAioaExecutable,
  type AioaCdpConnection,
  type AioaCdpPage,
  type AioaCdpPortAllocator,
  type AioaConversationSetupNavigator,
  type AioaConversationSetupSnapshot,
  type AioaStartedProcess,
  type AioaTrustedInput
} from "../src/core/aioaCdp.js";
import type { AgentExecutionRequest } from "../src/core/agentRunner.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import type { CodeRef, RegisteredCallable } from "../src/core/types.js";

function profile(mode: "attach" | "launch" = "attach"): AgentProfile {
  return {
    id: "aioa",
    label: "AIOA",
    provider: "aioa",
    command: "AIOA.exe",
    endpoint: "http://127.0.0.1:9229",
    connectionMode: mode,
    models: []
  };
}

function request(onEvent?: AgentExecutionRequest["onEvent"], agentSessionId?: string): AgentExecutionRequest {
  const method: RegisteredCallable = {
    ...BUILTIN_METHODS.find((candidate) => candidate.id === "ask")!,
    source: "builtin"
  };
  const target: CodeRef = {
    kind: "codeRef",
    uri: "file:///workspace/example.ts",
    content: "export const answer = 42;",
    documentVersion: 1,
    contentHash: "hash"
  };
  return {
    profile: profile(),
    cwd: "C:/workspace",
    method,
    contract: new AxAdapter().compile(method),
    resolved: {
      invocation: { kind: "invocation", method: method.id, arguments: [{ name: "input", value: "Explain the selected code" }], source: "code" },
      method,
      arguments: { input: "Explain the selected code" },
      context: [target],
      metadata: agentSessionId ? { agentSessionId } : {}
    },
    metadata: agentSessionId ? { agentSessionId } : {},
    ...(onEvent ? { onEvent } : {})
  };
}

function chatRequest(message: string, agentSessionId = "output-session"): AgentExecutionRequest {
  const method: RegisteredCallable = {
    ...BUILTIN_METHODS.find((candidate) => candidate.id === "ask")!,
    source: "builtin"
  };
  return {
    profile: profile(),
    cwd: "C:/workspace",
    method,
    contract: new AxAdapter().compile(method),
    resolved: {
      invocation: { kind: "invocation", method: method.id, arguments: [{ name: "input", value: message }], source: "chat" },
      method,
      arguments: { input: message },
      context: [],
      metadata: { agentSessionId }
    },
    metadata: { agentSessionId }
  };
}

function page(overrides: Partial<AioaCdpPage> = {}): AioaCdpPage {
  return {
    state: async () => ({ busy: false, assistantIds: [] }),
    createConversation: async () => undefined,
    submit: async () => undefined,
    updatesAfter: async () => ({ busy: false, messages: [] }),
    close: async () => undefined,
    ...overrides
  };
}

function portAllocator(...ports: number[]): AioaCdpPortAllocator & { allocate: ReturnType<typeof vi.fn> } {
  const allocate = vi.fn();
  for (const port of ports) allocate.mockResolvedValueOnce(port);
  return { allocate };
}

function startedProcess(failure: () => ReturnType<AioaStartedProcess["failure"]> = () => undefined): AioaStartedProcess {
  return { pid: 42, failure };
}

function setupSnapshot(
  overrides: Partial<AioaConversationSetupSnapshot> = {}
): AioaConversationSetupSnapshot {
  return {
    globalNewTaskPoints: [],
    visibleMessageCount: 0,
    workspaceRows: [],
    ...overrides
  };
}

function setupNavigator(
  snapshots: readonly AioaConversationSetupSnapshot[]
): AioaConversationSetupNavigator & {
  click: ReturnType<typeof vi.fn>;
  replaceText: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const click = vi.fn().mockResolvedValue(undefined);
  const replaceText = vi.fn().mockResolvedValue(undefined);
  return {
    snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)] ?? setupSnapshot(),
    click,
    replaceText
  };
}

describe("AIOA CDP", () => {
  it("uses one compact ask API definition followed by flat requests", () => {
    const first = chatRequest("你好");
    const next = chatRequest("你能为我做些什么吗？");
    expect(aioaApiDefinition(first)).toBe([
      "Define API ask",
      "Input: input:string, workspace?:dir",
      "Output: {\"kind\":\"chat\",\"text\":string}"
    ].join("\n"));
    expect(aioaExecutionPrompt(first)).toBe([
      "Dext task: Ask",
      aioaBootstrapPrompt(),
      "Define API ask\nInput: input:string, workspace?:dir\nOutput: {\"kind\":\"chat\",\"text\":string}\n\nRequest: {\"api\":\"ask\",\"input\":\"你好\"}"
    ].join("\n\n"));
    expect(aioaTurnPrompt(next, false)).toBe("Request: {\"api\":\"ask\",\"input\":\"你能为我做些什么吗？\"}");
  });

  it("keeps agent preview and workspace-write instructions aligned with apply", () => {
    const method: RegisteredCallable = {
      ...BUILTIN_METHODS.find((candidate) => candidate.id === "agent")!,
      source: "builtin"
    };
    expect(aioaBootstrapPrompt({ method, allowWorkspaceWrite: false })).toContain("preview-only");
    expect(aioaBootstrapPrompt({ method, allowWorkspaceWrite: true })).toContain("selected trusted workspace");
  });

  it("renders compact input and complex JSON Schema types without metadata", () => {
    expect(aioaInputType([
      { name: "mode", type: "enum", values: ["fast", "safe"], required: true },
      { name: "targets", type: "context", accepts: ["result"], multiple: true },
      { name: "timeout", type: "number", default: 1000 }
    ])).toBe('mode:"fast"|"safe", targets?:(Context|DextResult)[], timeout?:number=1000');
    expect(aioaOutputType({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        item: {
          type: "object",
          properties: { id: { type: "integer" }, label: { type: ["string", "null"] } },
          required: ["id"],
          additionalProperties: false
        }
      },
      type: "object",
      properties: {
        kind: { const: "complex" },
        items: { type: "array", items: { $ref: "#/$defs/item" } },
        state: { oneOf: [{ enum: ["ready", "busy"] }, { type: "null" }] },
        marker: { const: "fixed", nullable: true },
        detail: { allOf: [{ type: "object", properties: { name: { type: "string" } }, required: ["name"] }], nullable: true },
        metadata: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }] } }
      },
      required: ["kind", "items", "state"],
      additionalProperties: false,
      description: "ignored"
    })).toBe('{"detail"?:{"name":string}|null,"items":({"id":number,"label"?:string|null})[],"kind":"complex","marker"?:"fixed"|null,"metadata"?:{[key:string]:string|number},"state":"ready"|"busy"|null}');
  });

  it("flattens AIOA arguments, normalizes multiple values, and omits empty context", () => {
    expect(aioaRequestPayload(chatRequest("Hello"))).toBe('{"api":"ask","input":"Hello"}');
    expect(aioaRequestPayload(request())).toBe('{"api":"ask","input":"Explain the selected code"}');
  });

  it("accepts only a plain local CDP endpoint", () => {
    expect(normalizeAioaCdpEndpoint("http://127.0.0.1:9229/")).toBe("http://127.0.0.1:9229");
    expect(normalizeAioaCdpEndpoint("http://[::1]:9229")).toBe("http://[::1]:9229");
    expect(() => normalizeAioaCdpEndpoint("http://127.0.0.1")).toThrow(/port/i);
    expect(() => normalizeAioaCdpEndpoint("https://127.0.0.1:9229")).toThrow(/loopback/i);
    expect(() => normalizeAioaCdpEndpoint("http://192.168.1.20:9229")).toThrow(/loopback/i);
    expect(() => normalizeAioaCdpEndpoint("http://user@127.0.0.1:9229")).toThrow(/credentials/i);
  });

  it("creates an empty task, searches the full picker, and selects the normalized workspace", async () => {
    const newTask = { x: 10, y: 20 };
    const selector = { x: 30, y: 40 };
    const search = { x: 50, y: 60 };
    const workspace = { x: 70, y: 80 };
    const navigator = setupNavigator([
      setupSnapshot({ globalNewTaskPoints: [newTask], visibleMessageCount: 4 }),
      setupSnapshot({
        globalNewTaskPoints: [newTask],
        workspaceSelectorPoint: selector,
        selectedWorkspaceName: "dext"
      }),
      setupSnapshot({ workspaceSelectorPoint: selector, workspaceSearchPoint: search }),
      setupSnapshot({
        workspaceSelectorPoint: selector,
        workspaceSearchPoint: search,
        workspaceRows: [{ name: "  \uff22\uff25\uff38\uff34  ", point: workspace, selected: false }]
      }),
      setupSnapshot({ selectedWorkspaceName: "bext" })
    ]);

    expect(normalizeAioaWorkspaceName("  \uff22\uff25\uff38\uff34  ")).toBe("bext");
    await openAioaWorkspaceConversation("C:/github/bExT/", navigator, {
      pollIntervalMs: 1,
      sleep: async () => undefined
    });

    expect(navigator.click.mock.calls).toEqual([[newTask], [selector], [workspace]]);
    expect(navigator.replaceText).toHaveBeenCalledWith(search, "bExT");
  });

  it("waits for an asynchronously rendered workspace picker", async () => {
    const newTask = { x: 10, y: 20 };
    const selector = { x: 30, y: 40 };
    const search = { x: 50, y: 60 };
    const workspace = { x: 70, y: 80 };
    const navigator = setupNavigator([
      setupSnapshot({ globalNewTaskPoints: [newTask] }),
      setupSnapshot({ workspaceSelectorPoint: selector }),
      setupSnapshot({ workspaceSelectorPoint: selector }),
      setupSnapshot({ workspaceSelectorPoint: selector, workspaceSearchPoint: search }),
      setupSnapshot({ workspaceRows: [{ name: "bext", point: workspace, selected: false }] }),
      setupSnapshot({ selectedWorkspaceName: "bext" })
    ]);

    await openAioaWorkspaceConversation("C:/github/bext", navigator, {
      timeoutMs: 2,
      pollIntervalMs: 1,
      sleep: async () => undefined
    });

    expect(navigator.replaceText).toHaveBeenCalledOnce();
    expect(navigator.click.mock.calls).toEqual([[newTask], [selector], [workspace]]);
  });

  it("reports picker workspaces when the target is missing", async () => {
    const navigator = setupNavigator([
      setupSnapshot({ globalNewTaskPoints: [{ x: 10, y: 20 }] }),
      setupSnapshot({ workspaceSelectorPoint: { x: 30, y: 40 } }),
      setupSnapshot({ workspaceSearchPoint: { x: 50, y: 60 } }),
      setupSnapshot({
        workspaceRows: [
          { name: "dext", point: { x: 70, y: 80 }, selected: false },
          { name: "client", point: { x: 90, y: 100 }, selected: false }
        ]
      })
    ]);

    await expect(openAioaWorkspaceConversation("C:/github/bext", navigator, {
      timeoutMs: 0,
      pollIntervalMs: 1,
      sleep: async () => undefined
    })).rejects.toThrow(/'dext', 'client'/i);
  });

  it("rejects duplicate normalized workspace names in the picker", async () => {
    const navigator = setupNavigator([
      setupSnapshot({ globalNewTaskPoints: [{ x: 10, y: 20 }] }),
      setupSnapshot({ workspaceSelectorPoint: { x: 30, y: 40 } }),
      setupSnapshot({ workspaceSearchPoint: { x: 50, y: 60 } }),
      setupSnapshot({
        workspaceRows: [
          { name: "bext", point: { x: 70, y: 80 }, selected: false },
          { name: " BEXT ", point: { x: 90, y: 100 }, selected: false }
        ]
      })
    ]);

    await expect(openAioaWorkspaceConversation("C:/github/bext", navigator, {
      timeoutMs: 0,
      pollIntervalMs: 1,
      sleep: async () => undefined
    })).rejects.toThrow(/multiple workspaces matching/i);
    expect(navigator.click).toHaveBeenCalledTimes(2);
  });

  it("rejects a workspace selection that is not verified on the empty task", async () => {
    const navigator = setupNavigator([
      setupSnapshot({ globalNewTaskPoints: [{ x: 10, y: 20 }] }),
      setupSnapshot({ workspaceSelectorPoint: { x: 30, y: 40 } }),
      setupSnapshot({ workspaceSearchPoint: { x: 50, y: 60 } }),
      setupSnapshot({ workspaceRows: [{ name: "bext", point: { x: 70, y: 80 }, selected: false }] }),
      setupSnapshot({ selectedWorkspaceName: "dext" })
    ]);

    await expect(openAioaWorkspaceConversation("C:/github/bext", navigator, {
      timeoutMs: 0,
      pollIntervalMs: 1,
      sleep: async () => undefined
    })).rejects.toThrow(/did not select workspace 'bext'/i);
  });

  it("does not accept the selected workspace while the new task has visible messages", async () => {
    const navigator = setupNavigator([
      setupSnapshot({ globalNewTaskPoints: [{ x: 10, y: 20 }] }),
      setupSnapshot({ workspaceSelectorPoint: { x: 30, y: 40 } }),
      setupSnapshot({ workspaceSearchPoint: { x: 50, y: 60 } }),
      setupSnapshot({ workspaceRows: [{ name: "bext", point: { x: 70, y: 80 }, selected: false }] }),
      setupSnapshot({ selectedWorkspaceName: "bext", visibleMessageCount: 1 })
    ]);

    await expect(openAioaWorkspaceConversation("C:/github/bext", navigator, {
      timeoutMs: 0,
      pollIntervalMs: 1,
      sleep: async () => undefined
    })).rejects.toThrow(/new empty task/i);
  });

  it("uses trusted CDP mouse and keyboard input to replace workspace search text", async () => {
    const dispatchMouseEvent = vi.fn().mockResolvedValue({});
    const dispatchKeyEvent = vi.fn().mockResolvedValue({});
    const insertText = vi.fn().mockResolvedValue({});
    const input = { dispatchMouseEvent, dispatchKeyEvent, insertText } as unknown as AioaTrustedInput;

    await replaceAioaText(input, { x: 10, y: 20 }, "bext");

    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "mousePressed" }));
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "mouseReleased" }));
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "keyDown", key: "Control" }));
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "keyDown", key: "a" }));
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: "keyUp", key: "a" }));
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(4, expect.objectContaining({ type: "keyUp", key: "Control" }));
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(5, expect.objectContaining({ type: "keyDown", key: "Backspace" }));
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(6, expect.objectContaining({ type: "keyUp", key: "Backspace" }));
    expect(insertText).toHaveBeenCalledWith({ text: "bext" });
  });

  it("launches AIOA on a dynamic loopback-only port when the fixed endpoint fails", async () => {
    const ready = page();
    const connector = { connect: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(ready) };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const allocator = portAllocator(42_001);
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 20,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      portAllocator: allocator
    });

    const launchProfile = { ...profile("launch"), endpoint: "http://localhost:9229" };
    const opened = await connection.open(launchProfile);

    expect(opened).toEqual({ page: ready, launched: true });
    expect(launcher.launch).toHaveBeenCalledWith("AIOA.exe", [
      "--remote-debugging-port=42001",
      "--remote-debugging-address=127.0.0.1"
    ]);
    expect(allocator.allocate).toHaveBeenCalledOnce();
    expect(aioaLaunchArguments("http://localhost:9876")).toEqual([
      "--remote-debugging-port=9876",
      "--remote-debugging-address=127.0.0.1"
    ]);
    expect(connector.connect).toHaveBeenNthCalledWith(1, "http://localhost:9229");
    expect(connector.connect).toHaveBeenNthCalledWith(2, "http://127.0.0.1:42001");
  });

  it("does not allocate or launch when the fixed launch endpoint is healthy", async () => {
    const ready = page();
    const connector = { connect: vi.fn().mockResolvedValue(ready) };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const allocator = portAllocator(42_002);
    const connection = new DefaultAioaCdpConnection(connector, launcher, { portAllocator: allocator });

    await expect(connection.open(profile("launch"))).resolves.toEqual({ page: ready, launched: false });
    expect(allocator.allocate).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("keeps a successful manual localhost attachment on its configured endpoint", async () => {
    const ready = page();
    const connector = { connect: vi.fn().mockResolvedValue(ready) };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const connection = new DefaultAioaCdpConnection(connector, launcher);

    const opened = await connection.open({ ...profile("attach"), endpoint: "http://localhost:9229" });

    expect(opened).toEqual({ page: ready, launched: false });
    expect(connector.connect).toHaveBeenCalledWith("http://localhost:9229");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("does not allocate or launch when attach mode cannot reach its fixed endpoint", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("offline")) };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const allocator = portAllocator(42_003);
    const connection = new DefaultAioaCdpConnection(connector, launcher, { portAllocator: allocator });

    await expect(connection.open(profile("attach"))).rejects.toThrow(/Unable to attach/i);
    expect(allocator.allocate).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("keeps polling a cold AIOA launch until CDP becomes ready", async () => {
    const ready = page();
    const connector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("initial refused"))
        .mockRejectedValueOnce(new Error("starting"))
        .mockRejectedValueOnce(new Error("still starting"))
        .mockResolvedValueOnce(ready)
    };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const allocator = portAllocator(42_004);
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      portAllocator: allocator
    });

    await expect(connection.open(profile("launch"))).resolves.toEqual({ page: ready, launched: true });
    expect(connector.connect).toHaveBeenCalledTimes(4);
    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it("reports a launcher spawn error with the CDP endpoint", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("offline")) };
    const launcher = { launch: vi.fn().mockRejectedValue(new Error("spawn ENOENT")) };
    const connection = new DefaultAioaCdpConnection(connector, launcher, { portAllocator: portAllocator(42_005) });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/127\.0\.0\.1:42005.*spawn ENOENT/i);
  });

  it("keeps polling after an AIOA process exit and reports it with the final CDP failure", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("offline")) };
    const launcher = {
      launch: vi.fn().mockResolvedValue(startedProcess(() => ({ kind: "exit", code: 0, signal: null })))
    };
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 0,
      sleep: async () => undefined,
      portAllocator: portAllocator(42_006, 42_007)
    });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/exited before CDP.*code 0.*offline/i);
    expect(connector.connect).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after an AIOA process error and reports it with the final CDP failure", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("offline")) };
    const launcher = {
      launch: vi.fn().mockResolvedValue(startedProcess(() => ({ kind: "error", error: new Error("access denied") })))
    };
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 0,
      sleep: async () => undefined,
      portAllocator: portAllocator(42_008, 42_009)
    });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/launch error: access denied.*offline/i);
    expect(connector.connect).toHaveBeenCalledTimes(3);
  });

  it("reports the endpoint and last CDP error after startup timeout", async () => {
    const connector = {
      connect: vi.fn().mockRejectedValue(new Error("CDP still refused"))
    };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 0,
      sleep: async () => undefined,
      portAllocator: portAllocator(42_010, 42_011)
    });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/fixed endpoint.*9229.*Last dynamic endpoint.*42011.*CDP still refused/i);
  });

  it("does not wait through a full startup timeout when a dynamic AIOA launch exits cleanly", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("CDP still refused")) };
    const launcher = {
      launch: vi.fn().mockResolvedValue(startedProcess(() => ({ kind: "exit", code: 0, signal: null })))
    };
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async () => undefined,
      portAllocator: portAllocator(42_014, 42_015)
    });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/exited before CDP.*code 0.*CDP still refused/i);
    // One failed fixed-endpoint probe plus a four-second grace window for each
    // dynamic launch, instead of two 60-second blind waits.
    expect(connector.connect).toHaveBeenCalledTimes(11);
  });

  it("stops polling immediately when a dynamic AIOA launch crashes with a non-zero exit", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("CDP still refused")) };
    const launcher = {
      launch: vi.fn().mockResolvedValue(startedProcess(() => ({ kind: "exit", code: 9, signal: null })))
    };
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async () => undefined,
      portAllocator: portAllocator(42_018, 42_019)
    });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/exited before CDP.*code 9.*CDP still refused/i);
    // One fixed-endpoint probe plus two dynamic launches that each stop after
    // the first poll, instead of two 60-second blind waits.
    expect(connector.connect).toHaveBeenCalledTimes(3);
  });

  it("reuses a healthy dynamic endpoint and falls back to a new one when it stops responding", async () => {
    const first = page();
    const second = page();
    const connector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("fixed offline"))
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new Error("cached offline"))
        .mockRejectedValueOnce(new Error("fixed offline"))
        .mockResolvedValueOnce(second)
    };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const allocator = portAllocator(42_012, 42_013);
    const connection = new DefaultAioaCdpConnection(connector, launcher, {
      startupTimeoutMs: 0,
      sleep: async () => undefined,
      portAllocator: allocator
    });

    await expect(connection.open(profile("launch"))).resolves.toEqual({ page: first, launched: true });
    await expect(connection.open(profile("launch"))).resolves.toEqual({ page: first, launched: false });
    await expect(connection.open(profile("launch"))).resolves.toEqual({ page: second, launched: true });
    expect(allocator.allocate).toHaveBeenCalledTimes(2);
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(connector.connect).toHaveBeenNthCalledWith(2, "http://127.0.0.1:42012");
    expect(connector.connect).toHaveBeenNthCalledWith(3, "http://127.0.0.1:42012");
    expect(connector.connect).toHaveBeenNthCalledWith(6, "http://127.0.0.1:42013");
  });

  it("reports an allocator failure without launching AIOA", async () => {
    const connector = { connect: vi.fn().mockRejectedValue(new Error("fixed offline")) };
    const launcher = { launch: vi.fn().mockResolvedValue(startedProcess()) };
    const allocator = { allocate: vi.fn().mockRejectedValue(new Error("bind denied")) };
    const connection = new DefaultAioaCdpConnection(connector, launcher, { portAllocator: allocator });

    await expect(connection.open(profile("launch"))).rejects.toThrow(/allocate.*9229.*bind denied/i);
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("preserves configured executables and probes the local AIOA installation as a fallback", () => {
    const environment = { LOCALAPPDATA: "C:/Users/Test/AppData/Local" };
    const fallback = defaultAioaExecutable(environment);
    expect(resolveAioaExecutable("custom-aioa.exe", environment, () => false)).toBe("custom-aioa.exe");
    expect(resolveAioaExecutable("C:/tools/AIOA.exe", environment, (path) => path === "C:/tools/AIOA.exe"))
      .toBe("C:/tools/AIOA.exe");
    expect(resolveAioaExecutable("C:/missing/AIOA.exe", environment, (path) => path === fallback)).toBe(fallback);
    expect(() => resolveAioaExecutable("", environment, () => false)).toThrow(/Checked:.*AIOA\.exe/i);
  });

  it("streams only the new AIOA response and returns its typed JSON", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const updatesAfter = vi.fn()
      .mockResolvedValueOnce({ busy: true, messages: [] })
      .mockResolvedValueOnce({
        busy: false,
        messages: [{ id: "new", text: '{"kind":"chat","text":"The value is exported."}' }],
        conversationId: "dext-task-1"
      });
    const connection: AioaCdpConnection = {
      open: async () => ({ page: page({ submit, updatesAfter, close }), launched: false })
    };
    const events: string[] = [];
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });

    const result = await runner.run(request((event) => events.push(`${event.phase}:${event.text}`)));

    expect(result).toEqual({ kind: "chat", text: "The value is exported." });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(aioaExecutionPrompt(request())).toContain("Do not modify workspace files");
    expect(events).toEqual([
      "status:Connecting to AIOA",
      "status:Creating an AIOA task in the Dext workspace",
      "status:Waiting for AIOA response"
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports an AIOA turn that never starts responding instead of waiting for the global timeout", async () => {
    let now = 0;
    const events: string[] = [];
    const connection: AioaCdpConnection = {
      open: async () => ({ page: page({ updatesAfter: async () => ({ busy: true, messages: [] }) }), launched: false })
    };
    const runner = new AioaCdpAgentRunner(connection, {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      initialResponseTimeoutMs: 20,
      sleep: async () => { now += 10; },
      now: () => now
    });

    await expect(runner.run(request((event) => events.push(`${event.phase}:${event.text}`))))
      .rejects.toThrow(/did not begin responding within 1 seconds/i);
    expect(events).toContain("status:Waiting for AIOA response");
  });

  it("keeps a silent work log private while using it to detect whether AIOA is still active", async () => {
    let now = 0;
    const events: string[] = [];
    const connection: AioaCdpConnection = {
      open: async () => ({
        page: page({ updatesAfter: async () => ({ busy: true, messages: [], activity: "private work-log detail" }) }),
        launched: false
      })
    };
    const runner = new AioaCdpAgentRunner(connection, {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      initialResponseTimeoutMs: 20,
      responseIdleTimeoutMs: 30,
      sleep: async () => { now += 10; },
      now: () => now
    });

    await expect(runner.run(request((event) => events.push(`${event.phase}:${event.text}`))))
      .rejects.toThrow(/stopped responding for 1 seconds/i);
    expect(events).toContain("status:AIOA is working");
    expect(events.join("\n")).not.toContain("private work-log detail");
  });

  it("keeps polling until final content mounts after the work log finishes", async () => {
    const updatesAfter = vi.fn()
      .mockResolvedValueOnce({ busy: false, messages: [], conversationId: "dext-task-1" })
      .mockResolvedValueOnce({
        busy: false,
        messages: [{ id: "position:4", text: '{"kind":"chat","text":"Hello"}' }],
        conversationId: "dext-task-1"
      });
    const connection: AioaCdpConnection = {
      open: async () => ({ page: page({ updatesAfter }), launched: false })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });

    await expect(runner.run(chatRequest("Hello"))).resolves.toEqual({ kind: "chat", text: "Hello" });
    expect(updatesAfter).toHaveBeenCalledTimes(2);
  });

  it("parses a typed result after AIOA adds execution status text", async () => {
    const updatesAfter = vi.fn()
      .mockResolvedValueOnce({ busy: true, messages: [] })
      .mockResolvedValueOnce({
        busy: false,
        messages: [{ id: "position:4", text: "Executed for 4 seconds\n\n{\"kind\":\"chat\",\"text\":\"Hello\"}" }],
        conversationId: "dext-task-1"
      });
    const connection: AioaCdpConnection = {
      open: async () => ({ page: page({ updatesAfter }), launched: false })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });

    await expect(runner.run(chatRequest("Hello"))).resolves.toEqual({ kind: "chat", text: "Hello" });
  });

  it("selects the current API result from mixed JSON without treating nested code references as output", () => {
    const response = [
      'Request: {"api":"ask","input":"Explain the selected code"}',
      'Result: {"kind":"chat","text":"The value is exported."}'
    ].join("\n\n");

    expect(parseJsonOutput(response, "chat")).toEqual({
      kind: "chat",
      text: "The value is exported."
    });
  });

  it("does not submit while AIOA is already generating", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const connection: AioaCdpConnection = {
      open: async () => ({ page: page({ state: async () => ({ busy: true, assistantIds: [] }), submit }), launched: false })
    };
    const runner = new AioaCdpAgentRunner(connection, { sleep: async () => undefined });

    await expect(runner.run(request())).rejects.toThrow(/already generating/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it("creates one AIOA task per Dext session and sends bootstrap rules only on the first turn", async () => {
    let conversationId: string | undefined;
    const createConversation = vi.fn(async () => { conversationId = undefined; });
    const submit = vi.fn().mockResolvedValue(undefined);
    const updatesAfter = vi.fn(async () => ({
      busy: false,
      messages: [{ id: `reply-${submit.mock.calls.length}`, text: '{"kind":"chat","text":"ok"}' }],
      conversationId: conversationId ??= "dext-task-1"
    }));
    const connection: AioaCdpConnection = {
      open: async () => ({
        page: page({
          state: async () => ({ busy: false, assistantIds: [], ...(conversationId ? { conversationId } : {}) }),
          createConversation,
          submit,
          updatesAfter
        }),
        launched: false
      })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });

    await runner.run(request(undefined, "output-session"));
    await runner.run(request(undefined, "output-session"));

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[0]).toContain(aioaBootstrapPrompt());
    expect(submit.mock.calls[1]?.[0]).not.toContain(aioaBootstrapPrompt());
    expect(submit.mock.calls[0]?.[0]).toContain("Define API ask");
    expect(submit.mock.calls[1]?.[0]).toBe('Request: {"api":"ask","input":"Explain the selected code"}');
  });

  it("reuses a defined API when the same AIOA session continues", async () => {
    let conversationId: string | undefined;
    const submit = vi.fn().mockResolvedValue(undefined);
    const connection: AioaCdpConnection = {
      open: async () => ({
        page: page({
          state: async () => ({ busy: false, assistantIds: [], ...(conversationId ? { conversationId } : {}) }),
          createConversation: async () => { conversationId = undefined; },
          submit,
          updatesAfter: async () => ({
            busy: false,
            messages: [{
              id: `reply-${submit.mock.calls.length}`,
              text: submit.mock.calls.length === 2
                ? '{"kind":"chat","text":"ok"}'
                : '{"kind":"chat","text":"ok"}'
            }],
            conversationId: conversationId ??= "dext-task-1"
          })
        }),
        launched: false
      })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });

    await runner.run(chatRequest("Hello"));
    await runner.run(request(undefined, "output-session"));
    await runner.run(chatRequest("Hello again"));

    expect(submit.mock.calls[1]?.[0]).toBe('Request: {"api":"ask","input":"Explain the selected code"}');
    expect(submit.mock.calls[1]?.[0]).not.toContain(aioaBootstrapPrompt());
    expect(submit.mock.calls[2]?.[0]).toBe('Request: {"api":"ask","input":"Hello again"}');
  });

  it("redefines an API name when its transmitted input definition changes", async () => {
    let conversationId: string | undefined;
    const submit = vi.fn().mockResolvedValue(undefined);
    const connection: AioaCdpConnection = {
      open: async () => ({
        page: page({
          state: async () => ({ busy: false, assistantIds: [], ...(conversationId ? { conversationId } : {}) }),
          createConversation: async () => { conversationId = undefined; },
          submit,
          updatesAfter: async () => ({
            busy: false,
            messages: [{ id: `reply-${submit.mock.calls.length}`, text: '{"kind":"chat","text":"ok"}' }],
            conversationId: conversationId ??= "dext-task-1"
          })
        }),
        launched: false
      })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });
    const changed = chatRequest("Hello again");
    changed.method = {
      ...changed.method,
      version: "1.1.0",
      input: [...changed.method.input, { name: "tone", type: "string" }]
    };
    changed.contract = new AxAdapter().compile(changed.method);
    changed.resolved = {
      ...changed.resolved,
      method: changed.method,
      arguments: { ...changed.resolved.arguments, tone: "brief" }
    };
    const descriptionOnly = {
      ...changed,
      method: { ...changed.method, description: "A locally revised description." },
      resolved: {
        ...changed.resolved,
        arguments: { ...changed.resolved.arguments, input: "One more" }
      }
    };
    descriptionOnly.contract = new AxAdapter().compile(descriptionOnly.method);
    descriptionOnly.resolved.method = descriptionOnly.method;

    await runner.run(chatRequest("Hello"));
    await runner.run(changed);
    await runner.run(descriptionOnly);

    expect(submit.mock.calls[1]?.[0]).toContain("Define API ask\nInput: input:string, workspace?:dir, tone?:string");
    expect(submit.mock.calls[1]?.[0]).toContain('Request: {"api":"ask","input":"Hello again","tone":"brief"}');
    expect(submit.mock.calls[2]?.[0]).toBe('Request: {"api":"ask","input":"One more","tone":"brief"}');
  });

  it("blocks a later turn when the user switched away from Dext's AIOA task", async () => {
    let conversationId: string | undefined;
    const submit = vi.fn().mockResolvedValue(undefined);
    const connection: AioaCdpConnection = {
      open: async () => ({
        page: page({
          state: async () => ({ busy: false, assistantIds: [], ...(conversationId ? { conversationId } : {}) }),
          createConversation: async () => { conversationId = undefined; },
          submit,
          updatesAfter: async () => ({
            busy: false,
            messages: [{ id: "reply", text: '{"kind":"chat","text":"ok"}' }],
            conversationId: conversationId ??= "dext-task-1"
          })
        }),
        launched: false
      })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });
    await runner.run(request(undefined, "output-session"));
    conversationId = "another-task";

    await expect(runner.run(request(undefined, "output-session"))).rejects.toThrow(/not the task created/i);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh AIOA task after the Dext session is cleared", async () => {
    let sequence = 0;
    let conversationId: string | undefined;
    const createConversation = vi.fn(async () => { conversationId = undefined; });
    const submit = vi.fn().mockResolvedValue(undefined);
    const connection: AioaCdpConnection = {
      open: async () => ({
        page: page({
          state: async () => ({ busy: false, assistantIds: [], ...(conversationId ? { conversationId } : {}) }),
          createConversation,
          submit,
          updatesAfter: async () => ({
            busy: false,
            messages: [{ id: "reply", text: '{"kind":"chat","text":"ok"}' }],
            conversationId: conversationId ??= `dext-task-${++sequence}`
          })
        }),
        launched: false
      })
    };
    const runner = new AioaCdpAgentRunner(connection, { pollIntervalMs: 0, sleep: async () => undefined });
    await runner.run(request(undefined, "output-session"));
    runner.endSession("output-session");
    await runner.run(request(undefined, "output-session"));

    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(sequence).toBe(2);
    expect(submit.mock.calls[0]?.[0]).toContain(aioaBootstrapPrompt());
    expect(submit.mock.calls[1]?.[0]).toContain(aioaBootstrapPrompt());
    expect(submit.mock.calls[1]?.[0]).toContain("Define API ask");
  });
});
