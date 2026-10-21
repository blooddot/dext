import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSelection } from "../src/features/agents/contracts.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";

const host = vi.hoisted(() => ({ post: vi.fn() }));
const output = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("vscode", () => ({
  workspace: { findFiles: async () => [{ path: "src/current.ts" }], asRelativePath: (uri: { path: string }) => uri.path },
  window: { ...host, createOutputChannel: () => ({ appendLine: (line: string) => { output.lines.push(line); } }) },
  commands: host,
  Uri: { joinPath: () => ({ toString: () => "" }) }
}));

import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { webviewRequestSchema } from "../src/webviewProtocol.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";

/**
 * The Composer gets its TypeScript support from the sidebar: the generated declaration
 * and the workspace's API modules. Both a push (on `ready`) and a pull (the composer
 * asking) deliver it, and the pull is what makes a Webview that missed the push — or
 * was created before it — still work. This is that path, on the host side.
 */
const types = {
  declaration: 'declare module "dext" { export function ask(options: { input: string }): Promise<unknown>; }',
  apiPaths: ["./api/*.ts", "./api/*.mts", "./api/*/index.ts"],
  modules: [{
    path: "api/git/commit.ts",
    specifier: "dext/api/git/commit",
    content: 'export async function commit(): Promise<string> { return "ok"; }'
  }]
};

const selection: AgentSelection = {
  mode: "agent", permission: "workspace-write", profileId: "codex", model: "model",
  reasoningEffort: "", speed: "", serviceTier: ""
};

class MemoryState {
  private values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return this.values.has(key) ? this.values.get(key) as T : fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

function sidebarHarness(): { sidebar: DextSidebarProvider; posted: WebviewResponse[] } {
  const posted: WebviewResponse[] = [];
  const sidebar = new DextSidebarProvider(
    {} as never,
    {
      composerTypes: async () => types,
      state: () => ({ agentSelection: selection }),
      setAgentSelection: vi.fn(),
      endAgentSession: vi.fn(),
      agentProfiles: () => []
    } as never,
    new DextHistoryStore(new MemoryState() as never),
    new DextConversationPreferences(new MemoryState() as never)
  );
  vi.spyOn(sidebar as unknown as { postWhenReady(message: WebviewResponse): void }, "postWhenReady")
    .mockImplementation((message) => { posted.push(message); });
  const internals = sidebar as unknown as { view: unknown; messageQueue: { markReady(): WebviewResponse[] } };
  internals.view = { webview: { postMessage: async () => undefined } };
  internals.messageQueue.markReady();
  return { sidebar, posted };
}

function receive(sidebar: DextSidebarProvider, request: unknown): Promise<void> {
  return (sidebar as unknown as { receive(raw: unknown): Promise<void> }).receive(request);
}

describe("the composer's TypeScript support", () => {
  beforeEach(() => { output.lines.length = 0; });

  it("accepts the requests the composer sends about it", () => {
    // A request the schema rejects is answered with "Invalid Webview request.", so this
    // is the difference between a pull that works and one that silently does nothing.
    expect(webviewRequestSchema.safeParse({ type: "composerTypes" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "composerTypesApplied", builtins: 24, modules: 3 }).success).toBe(true);
  });

  it("answers a request with the declaration and the workspace's APIs", async () => {
    const { sidebar, posted } = sidebarHarness();
    await receive(sidebar, { type: "composerTypes" });
    expect(posted.map((message) => message.type)).toEqual(["dextTypes"]);
    expect((posted[0] as unknown as typeof types).modules[0]!.specifier).toBe("dext/api/git/commit");
    expect((posted[0] as unknown as typeof types).declaration).toContain("declare module \"dext\"");
  });

  it("answers with the same payload the host pushes on ready", async () => {
    const { sidebar, posted } = sidebarHarness();
    await receive(sidebar, { type: "composerTypes" });
    const pulled = posted.at(-1);
    expect(pulled?.type).toBe("dextTypes");
    expect((pulled as unknown as typeof types).modules[0]!.specifier).toBe("dext/api/git/commit");
    expect((pulled as unknown as typeof types).declaration).toContain("declare module \"dext\"");
  });

  it("records what the input applied", async () => {
    const { sidebar } = sidebarHarness();
    await receive(sidebar, { type: "composerTypesApplied", builtins: 24, modules: 3 });
    expect(output.lines).toContain("[composer] applied by the input: 24 built-in name(s), 3 API module(s)");
  });

  it("restarts file search ownership when a browser document sends ready again", async () => {
    const { sidebar } = sidebarHarness();
    const post = vi.spyOn(sidebar as unknown as { post(message: WebviewResponse): Promise<void> }, "post")
      .mockImplementation(async () => undefined);
    await receive(sidebar, { type: "ready" });
    await receive(sidebar, { type: "searchFiles", requestId: 9, query: "" });
    await receive(sidebar, { type: "ready" });
    await receive(sidebar, { type: "searchFiles", requestId: 1, query: "" });
    expect(post.mock.calls.filter(([message]) => (message as { type: string }).type === "searchFilesResult")).toEqual([
      [{ type: "searchFilesResult", requestId: 9, files: ["src/current.ts"] }],
      [{ type: "searchFilesResult", requestId: 1, files: ["src/current.ts"] }]
    ]);
  });
});
