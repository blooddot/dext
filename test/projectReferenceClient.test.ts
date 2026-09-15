import { describe, expect, it, vi } from "vitest";
import { ProjectReferenceClient } from "../src/webview/projectReferenceClient.js";

describe("Project reference picker transport", () => {
  it("discards stale replies and resolves the newest query", async () => {
    const post = vi.fn();
    const client = new ProjectReferenceClient(post);
    const first = client.search("old");
    const second = client.search("新");
    expect(await first).toEqual([]);
    expect(post.mock.calls[1]?.[0]).toEqual({ type: "searchProjectReferences", requestId: "2", query: "新" });
    client.accept({ type: "projectReferenceSearchResult", requestId: "1", items: [] });
    const items = [{ objectId: "a", canonicalName: "New", kind: "module", aliases: [], token: "#New[a]" }];
    client.accept({ type: "projectReferenceSearchResult", requestId: "2", items });
    expect(await second).toEqual(items);
  });

  it("handles synchronous transports, errors, and disposal without hanging a completion", async () => {
    const error = vi.fn();
    const client = new ProjectReferenceClient((request) => {
      if (request.type === "searchProjectReferences") client.accept({ type: "projectReferenceSearchResult", requestId: request.requestId, items: [], error: "Knowledge unavailable" });
    }, error);
    expect(await client.search("")).toEqual([]);
    expect(error).toHaveBeenCalledWith("Knowledge unavailable");
    const pending = new ProjectReferenceClient(() => {});
    const result = pending.search(""); pending.dispose();
    expect(await result).toEqual([]);
  });
});
