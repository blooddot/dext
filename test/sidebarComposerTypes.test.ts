import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebviewResponse } from "../src/webviewProtocol.js";

const host = vi.hoisted(() => ({ post: vi.fn() }));
const output = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("vscode", () => ({
  window: { ...host, createOutputChannel: () => ({ appendLine: (line: string) => { output.lines.push(line); } }) },
  commands: host,
  Uri: { joinPath: () => ({ toString: () => "" }) }
}));

import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { webviewRequestSchema } from "../src/webviewProtocol.js";

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

function sidebarHarness(): { sidebar: DextSidebarProvider; posted: WebviewResponse[] } {
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  const posted: WebviewResponse[] = [];
  Object.assign(sidebar, {
    application: { composerTypes: async () => types },
    postWhenReady: (message: WebviewResponse) => { posted.push(message); }
  });
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
    expect(posted).toEqual([{ type: "dextTypes", ...types }]);
    // The Output panel is how this is diagnosed without a debugger: one line each way.
    expect(output.lines).toEqual(["[composer] types requested: 1 built-in name(s), 1 API module(s)"]);
  });

  it("answers with the same payload the host pushes on ready", async () => {
    const { sidebar, posted } = sidebarHarness();
    await receive(sidebar, { type: "composerTypes" });
    const pulled = posted[0];
    expect(pulled?.type).toBe("dextTypes");
    expect((pulled as unknown as typeof types).modules[0]!.specifier).toBe("dext/api/git/commit");
    expect((pulled as unknown as typeof types).declaration).toContain("declare module \"dext\"");
  });

  it("records what the input applied", async () => {
    const { sidebar } = sidebarHarness();
    await receive(sidebar, { type: "composerTypesApplied", builtins: 24, modules: 3 });
    expect(output.lines).toContain("[composer] applied by the input: 24 built-in name(s), 3 API module(s)");
  });
});
