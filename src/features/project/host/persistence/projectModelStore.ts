import type { ProjectModel } from "../../contracts/projectModel.js";
import { parseProjectModel } from "../../knowledge/projectModel.js";
import type { ProjectFileHost } from "./projectStore.js";
import { projectContentHash } from "./projectHash.js";

export const PROJECT_MODEL_PATH = ".dext/project/model.json";
export interface ProjectDocumentUpdate { path: string; beforeHash: string | null; content: string }

/** Native model is the commit record; document writes have durable recovery receipts. */
export class ProjectModelStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: ProjectFileHost) {}
  private readRaw(path: string): Promise<string | undefined> {
    return this.host.readFileStrict ? this.host.readFileStrict(path) : this.host.readFile(path);
  }
  async read(): Promise<ProjectModel | undefined> {
    const raw = await this.readRaw(PROJECT_MODEL_PATH);
    return raw === undefined ? undefined : parseProjectModel(JSON.parse(raw));
  }
  update(next: ProjectModel, expectedRevision: number | null, documents: readonly ProjectDocumentUpdate[] = []): Promise<ProjectModel> {
    const result = this.queue.then(() => this.commit(next, expectedRevision, documents));
    this.queue = result.catch(() => undefined); return result;
  }
  private async commit(next: ProjectModel, expectedRevision: number | null, documents: readonly ProjectDocumentUpdate[]): Promise<ProjectModel> {
    const raw = await this.readRaw(PROJECT_MODEL_PATH);
    const current = raw === undefined ? undefined : parseProjectModel(JSON.parse(raw));
    if ((current?.revision ?? null) !== expectedRevision) throw new Error("Project revision conflict.");
    const model = parseProjectModel({ ...next, revision: (current?.revision ?? -1) + 1, updatedAt: Date.now() });
    const paths = new Set<string>();
    for (const document of documents) {
      if (paths.has(document.path)) throw new Error("Duplicate Knowledge document update."); paths.add(document.path);
      const owners = model.nodes.filter(node => node.body.kind === "document" && node.body.path === document.path);
      if (owners.length !== 1 || owners[0]!.body.kind !== "document" || owners[0]!.body.contentHash !== projectContentHash(document.content)) throw new Error("Knowledge body ownership or hash mismatch.");
      const existing = await this.readRaw(document.path);
      const hash = existing === undefined ? null : projectContentHash(existing);
      if (hash !== document.beforeHash && hash !== projectContentHash(document.content)) throw new Error(`Knowledge document conflict: ${document.path}`);
    }
    const transaction = `.dext/project/migrations/update-${projectContentHash(JSON.stringify({ expectedRevision, model: next, documents })).slice(0, 24)}.json`;
    const receipts: string[] = [];
    if (documents.length) await this.host.writeFile(transaction, JSON.stringify({ expectedRevision, model, documents, receipts }));
    for (const document of documents) {
      const latest = await this.readRaw(document.path);
      const hash = latest === undefined ? null : projectContentHash(latest);
      if (hash !== document.beforeHash && hash !== projectContentHash(document.content)) throw new Error(`Knowledge document changed during update: ${document.path}`);
      if (hash !== projectContentHash(document.content)) await this.host.writeFile(document.path, document.content);
      receipts.push(document.path);
      await this.host.writeFile(transaction, JSON.stringify({ expectedRevision, model, documents, receipts }));
    }
    if (await this.readRaw(PROJECT_MODEL_PATH) !== raw) throw new Error("Project changed during document commit; recovery journal retained.");
    await this.host.writeFile(PROJECT_MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`);
    if (documents.length) await this.host.writeFile(transaction, JSON.stringify({ expectedRevision, model, documents, receipts, committed: true }));
    return model;
  }
}
