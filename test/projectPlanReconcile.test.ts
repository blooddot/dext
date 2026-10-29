import { describe, expect, it } from "vitest";
import { ProjectPlanReconciler, type ProjectReconcileReceipt } from "../src/features/project/host/projectPlanReconcile.js";
import { ProjectStore, projectContentHash } from "../src/features/project/host/persistence/projectStore.js";
import type { ProjectDelta } from "../src/shared/contracts/planProject.js";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";

function fixture() {
  const object = { id: "a", canonicalName: "Api", kind: "module", source: "user", description: "before" };
  const path = ".dext/objects/a.json", raw = JSON.stringify(object);
  const files = new Map([[path, raw]]);
  const store = new ProjectStore({ readFile: async path => files.get(path), writeFile: async (path, value) => { files.set(path, value); }, deleteFile: async path => { files.delete(path); }, listDirectory: async dir => [...files.keys()].filter(path => path.startsWith(dir + "/")).map(path => path.slice(dir.length + 1)) });
  const delta: ProjectDelta = { op: "update", target: path, id: "a", beforeHash: projectContentHash(raw), after: { ...object, description: "after" }, evidence: ["src/api.ts"] };
  let receipts: ProjectReconcileReceipt[] = [];
  return { files, path, delta, reconciler: new ProjectPlanReconciler(store), request: () => ({ decision: "accept" as const, deltas: [delta], authorizedTargets: [path], receipts, saveReceipts: async (next: ProjectReconcileReceipt[]) => { receipts = next; } }) };
}
describe("Project reconciliation", () => {
  it("reconciles native node bodies with revision guards and resumes lost receipts", async () => {
    const f = fixture();
    const model = projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [{ id: "a", title: "API", canonicalName: "Api", kind: "contract", body: { kind: "inline", text: "before" } }], relations: [] });
    f.files.set(".dext/project/model.json", JSON.stringify(model));
    const delta: ProjectDelta = { op: "update", target: "node", id: "a", beforeHash: projectContentHash(JSON.stringify(model.nodes[0])), after: { ...model.nodes[0], body: { kind: "inline", text: "after" } }, evidence: ["src/api.ts"] };
    const request = { ...f.request(), deltas: [delta], authorizedTargets: ["node"] };
    await expect(f.reconciler.reconcile({ ...request, saveReceipts: async () => { throw new Error("receipt offline"); } })).rejects.toThrow("offline");
    const raw = f.files.get(".dext/project/model.json");
    expect(raw).toContain("after"); expect(await f.reconciler.reconcile(request)).toHaveLength(1);
    expect(f.files.get(".dext/project/model.json")).toBe(raw);
    expect(f.files.get(f.path)).toContain("before");
  });
  it("requires explicit scope and detects external edits", async () => {
    const f = fixture(); await expect(f.reconciler.reconcile({ ...f.request(), authorizedTargets: [] })).rejects.toThrow("not authorized");
    f.files.set(f.path, JSON.stringify({ id: "a", canonicalName: "Api", kind: "module", source: "user", description: "external" }));
    await expect(f.reconciler.reconcile(f.request())).rejects.toThrow("conflict");
  });
  it("validates references before writing and refuses deletion with incoming references", async () => {
    const f = fixture(); f.delta.after = { ...(f.delta.after as object), relatedIds: ["missing"] };
    await expect(f.reconciler.reconcile(f.request())).rejects.toThrow("missing");
    expect(f.files.get(f.path)).toContain("before");
    f.files.set(".dext/objects/b.json", JSON.stringify({ id: "b", canonicalName: "Other", kind: "module", source: "user", relatedIds: ["a"] }));
    await expect(f.reconciler.reconcile({ ...f.request(), deltas: [{ ...f.delta, op: "delete" }] })).rejects.toThrow("missing");
  });
  it("recovers an interrupted receipt and avoids duplicate writes", async () => {
    const f = fixture();
    await expect(f.reconciler.reconcile({ ...f.request(), saveReceipts: async () => { throw new Error("storage offline"); } })).rejects.toThrow("offline");
    expect(f.files.get(f.path)).toContain("after");
    const receipts = await f.reconciler.reconcile(f.request());
    expect(receipts).toHaveLength(1);
    expect(await f.reconciler.reconcile(f.request())).toEqual(receipts);
  });
  it("persists rejection without writing and rejects false none", async () => {
    const f = fixture();
    expect((await f.reconciler.reconcile({ ...f.request(), decision: "reject" }))[0]?.status).toBe("rejected");
    expect(f.files.get(f.path)).toContain("before");
    await expect(f.reconciler.reconcile({ ...f.request(), decision: "none" })).rejects.toThrow("none");
  });
});
