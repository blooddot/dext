import type { ProjectModelNode } from "../../contracts/projectModel.js";
import { structureFingerprint } from "../../knowledge/projectModel.js";
import { type ProjectStore, projectContentHash } from "./projectStore.js";

/** One editable norm: its body is inline text, or the workspace Markdown file that owns it. */
export interface ProjectNorm {
  id: string;
  title: string;
  text: string;
  kind: ProjectModelNode["kind"];
  review: ProjectModelNode["review"];
  freshness: ProjectModelNode["freshness"];
  evidence: string[];
}

const norm = (node: ProjectModelNode, text: string): ProjectNorm => ({
  id: node.id, title: node.title, text, kind: node.kind, review: node.review, freshness: node.freshness,
  evidence: node.evidence.map((entry) => entry.path)
});

export async function listProjectNorms(store: ProjectStore): Promise<ProjectNorm[]> {
  const model = await store.readModel();
  const norms = await Promise.all((model?.nodes ?? []).map(async (node) => {
    const text = node.body.kind === "inline" ? node.body.text : await store.readStrict(node.body.path);
    return text === undefined ? undefined : norm(node, text);
  }));
  return norms.flatMap((entry) => entry ?? []);
}

export async function readProjectNorm(store: ProjectStore, id: string): Promise<ProjectNorm> {
  const found = (await listProjectNorms(store)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Project norm '${id}' has no readable body.`);
  return found;
}

/** An unchanged body is a confirmation; a changed body needs verification against its sources. */
export async function writeProjectNorm(store: ProjectStore, id: string, text: string): Promise<void> {
  const model = await store.readModel();
  const node = model?.nodes.find((candidate) => candidate.id === id);
  if (!model || !node) throw new Error(`Project norm '${id}' is missing.`);
  const path = node.body.kind === "document" ? node.body.path : undefined;
  const previous = path ? await store.readStrict(path) : node.body.kind === "inline" ? node.body.text : undefined;
  const changed = (previous ?? "").trim() !== text.trim();
  node.body = path ? { kind: "document", path, contentHash: projectContentHash(text) } : { kind: "inline", text };
  node.review = changed ? "edited" : "accepted";
  node.freshness = changed ? "needs_verification" : "current";
  // The confirmation covers this member/parent structure, not the prose wording.
  node.properties = { ...node.properties, structureHash: structureFingerprint(model, id) };
  // A document body moves through the same transaction, so the file and its hash always agree.
  const documents = path && changed ? [{ path, beforeHash: previous === undefined ? null : projectContentHash(previous), content: text }] : [];
  await store.updateProject(model, model.revision, documents);
}
