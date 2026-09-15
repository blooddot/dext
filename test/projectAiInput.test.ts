import { describe, expect, it, vi } from "vitest";
import { ReferenceProjection } from "../src/webview/monacoReferences.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";

vi.mock("vscode", () => ({}));
import { DextSidebarProvider } from "../src/sidebarProvider.js";

function harness() {
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  const messages: WebviewResponse[] = [];
  const run = vi.fn(async () => {});
  const search = vi.fn(async () => [{ objectId: "module-a", canonicalName: "Account", kind: "module", aliases: [], token: "#Account[module-a]" }]);
  const open = vi.fn(async (id: string) => { if (id === "missing") throw new Error("Unknown Project object: missing"); });
  Object.assign(sidebar, { run, post: async (message: WebviewResponse) => { messages.push(message); } });
  sidebar.setProjectReferenceSource({ search, open });
  const receive = (message: unknown) => (sidebar as unknown as { receive(message: unknown): Promise<void> }).receive(message);
  return { receive, messages, run, search, open };
}

describe("explicit Project references never expand user input", () => {
  it.each(["agent", "ask", "plan", "code"])("forwards %s source unchanged, with and without #", async (mode) => {
    const h = harness();
    for (const source of ["请检查 @src/main.ts", 'agent(input="修改 #Account[module-a] @src/main.ts")']) {
      const projection = new ReferenceProjection();
      const sent = projection.decode(projection.encode(source));
      await h.receive({ type: "executeInput", mode, source: sent });
      expect(h.run).toHaveBeenLastCalledWith(mode, source, undefined);
    }
    expect(h.search).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("queries and navigates only on explicit picker/click requests", async () => {
    const h = harness();
    await h.receive({ type: "searchProjectReferences", requestId: "q", query: "Account" });
    expect(h.messages[0]).toMatchObject({ type: "projectReferenceSearchResult", requestId: "q", items: [{ objectId: "module-a" }] });
    await h.receive({ type: "openProjectReference", objectId: "module-a" });
    expect(h.open).toHaveBeenCalledWith("module-a");
    expect(h.run).not.toHaveBeenCalled();
    await h.receive({ type: "openProjectReference", objectId: "missing" });
    expect(h.messages.at(-1)).toEqual({ type: "error", message: "Unknown Project object: missing" });
  });
});
