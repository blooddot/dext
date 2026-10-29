import { projectDeltaSchema, type ProjectDelta } from "../../../shared/contracts/planProject.js";
import { projectIntentSchema } from "../contracts/projectIntent.js";
import { normalizeProjectObject } from "../contracts/projectKnowledge.js";
import { ProjectStore, projectArchitectureSchema, projectContentHash } from "./persistence/projectStore.js";
import { projectModelNodeSchema, projectModelRelationSchema, type ProjectModel } from "../contracts/projectModel.js";
import { parseProjectModel } from "../knowledge/projectModel.js";

export interface ProjectReconcileReceipt { id: string; status: "applied" | "rejected"; afterHash: string | null }
export interface ProjectReconcileRequest {
  deltas: ProjectDelta[];
  /** Supplied only by the host after explicit plan authorization or proposal acceptance. */
  authorizedTargets: readonly string[];
  decision: "accept" | "reject" | "none";
  receipts: readonly ProjectReconcileReceipt[];
  saveReceipts(receipts: ProjectReconcileReceipt[]): Promise<void>;
}

function serialized(delta: ProjectDelta): string | undefined {
  if (delta.op === "delete" || delta.op === "none") return undefined;
  const parsed = delta.target === ".dext/project-intent.json" ? projectIntentSchema.parse(delta.after)
    : delta.target === ".dext/architecture.json" ? projectArchitectureSchema.parse(delta.after)
    : /^\.dext\/objects\/[^/\\]+\.json$/.test(delta.target) ? normalizeProjectObject(delta.after)
    : undefined;
  if (!parsed) throw new Error(`Unsupported Project target '${delta.target}'.`);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Validates the entire proposed legacy state before the first write, then receipts each write. */
export class ProjectPlanReconciler {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: ProjectStore) {}

  reconcile(request: ProjectReconcileRequest): Promise<ProjectReconcileReceipt[]> {
    const next = this.queue.then(() => this.apply(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply(request: ProjectReconcileRequest): Promise<ProjectReconcileReceipt[]> {
    const deltas = request.deltas.map(delta => projectDeltaSchema.parse(delta));
    if (request.decision === "none" && deltas.some(delta => delta.op !== "none")) throw new Error("none cannot discard proposed norm changes.");
    const native = await this.store.readModel();
    if (native) return this.applyNative(native, { ...request, deltas });
    const receipts = [...request.receipts];
    // A previously interrupted batch may temporarily have missing cross-file endpoints.
    // Validate the complete overlay below, while every touched file keeps its hash guard.
    const files = new Map((await this.store.readLegacySnapshot(false)).files.map(file => [file.path, file.raw]));
    const pending: Array<{ delta: ProjectDelta; id: string; content: string | undefined }> = [];
    const targets = new Set<string>();
    for (const delta of deltas) {
      if (delta.op === "none") continue;
      if (targets.has(delta.target)) throw new Error("Each reconciliation batch must consolidate changes to one operation per file.");
      targets.add(delta.target);
      if (!request.authorizedTargets.includes(delta.target)) throw new Error(`Project update is not authorized: ${delta.target}`);
      const id = projectContentHash(JSON.stringify(delta));
      const content = serialized(delta);
      if (content && delta.target.startsWith(".dext/objects/") && (JSON.parse(content) as { id: string }).id !== delta.id) throw new Error("Project identity cannot change during update.");
      const afterHash = content === undefined ? null : projectContentHash(content);
      const existing = receipts.find(receipt => receipt.id === id);
      const current = await this.store.readStrict(delta.target);
      const currentHash = current === undefined ? null : projectContentHash(current);
      if (existing) {
        if (existing.status === "applied" && currentHash !== existing.afterHash) throw new Error(`Previously reconciled Project target changed: ${delta.target}`);
        continue;
      }
      if (request.decision === "reject") {
        receipts.push({ id, status: "rejected", afterHash: currentHash }); continue;
      }
      if (currentHash === afterHash) {
        // Recovery after file write succeeded but receipt persistence was interrupted.
        receipts.push({ id, status: "applied", afterHash }); continue;
      }
      if (currentHash !== delta.beforeHash) throw new Error(`Project update conflict: ${delta.target}`);
      if (content === undefined) files.delete(delta.target); else files.set(delta.target, content);
      pending.push({ delta, id, content });
    }
    if (request.decision === "reject") { await request.saveReceipts(receipts); return receipts; }
    const overlay = new ProjectStore({ readFile: async path => files.get(path) ?? (path.startsWith(".dext/objects/") ? undefined : this.store.readStrict(path)),
      listDirectory: dir => dir === ".dext/objects" ? Promise.resolve([...files.keys()].filter(path => path.startsWith(dir + "/")).map(path => path.slice(dir.length + 1))) : this.store.listStrict(dir),
      writeFile: () => Promise.reject(new Error("Validation must not write."))
    });
    await overlay.readLegacySnapshot();
    for (const { delta, id, content } of pending) {
      const result = delta.op === "delete" ? await this.store.deleteLegacyChecked(delta.target, delta.beforeHash!)
        : await this.store.writeLegacyChecked(delta.target, delta.after, delta.beforeHash);
      if (result !== "applied") throw new Error(`Project changed during reconciliation: ${delta.target}`);
      receipts.push({ id, status: "applied", afterHash: content === undefined ? null : projectContentHash(content) });
      await request.saveReceipts([...receipts]);
    }
    await request.saveReceipts(receipts);
    return receipts;
  }

  private async applyNative(model: ProjectModel, request: ProjectReconcileRequest): Promise<ProjectReconcileReceipt[]> {
    const next = structuredClone(model); const receipts = [...request.receipts]; const touched = new Set<string>();
    for (const delta of request.deltas) {
      if (delta.op === "none") continue;
      if (!request.authorizedTargets.includes(delta.target)) throw new Error(`Project update is not authorized: ${delta.target}`);
      if (delta.target !== "node" && delta.target !== "relation") throw new Error("Native deltas use node or relation targets; body edits replace their owning node.");
      const key = `${delta.target}:${delta.id}`;
      if (touched.has(key)) throw new Error(`Duplicate update target: ${key}`); touched.add(key);
      const collection = delta.target === "node" ? next.nodes : next.relations;
      const current = collection.find(item => item.id === delta.id);
      const before = current ? projectContentHash(JSON.stringify(current)) : null;
      const id = projectContentHash(JSON.stringify(delta));
      const existing = receipts.find(receipt => receipt.id === id);
      if (existing) {
        if (existing.status === "applied" && existing.afterHash !== before) throw new Error(`Previously reconciled target changed: ${key}`);
        continue;
      }
      if (request.decision === "reject") { receipts.push({ id, status: "rejected", afterHash: before }); continue; }
      const after = delta.op === "delete" ? undefined : delta.target === "node" ? projectModelNodeSchema.parse(delta.after) : projectModelRelationSchema.parse(delta.after);
      if (after && after.id !== delta.id) throw new Error("Project identity cannot change during update.");
      const afterHash = after ? projectContentHash(JSON.stringify(after)) : null;
      if (before !== delta.beforeHash && before !== afterHash) throw new Error(`Project update conflict: ${key}`);
      if (delta.target === "node") next.nodes = [...next.nodes.filter(node => node.id !== delta.id), ...(after ? [projectModelNodeSchema.parse(after)] : [])];
      else next.relations = [...next.relations.filter(edge => edge.id !== delta.id), ...(after ? [projectModelRelationSchema.parse(after)] : [])];
      receipts.push({ id, status: "applied", afterHash });
    }
    if (request.decision === "accept" && JSON.stringify(next) !== JSON.stringify(model)) await this.store.updateProject(parseProjectModel(next), model.revision);
    await request.saveReceipts(receipts);
    return receipts;
  }
}
