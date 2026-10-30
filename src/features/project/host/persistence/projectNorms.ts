import type { ProjectModelNode } from "../../contracts/projectModel.js";
import type { ProjectStore } from "./projectStore.js";

/** One editable norm: its body is inline text, because a document owns its own file. */
export interface ProjectNorm {
  id: string;
  title: string;
  text: string;
  kind: ProjectModelNode["kind"];
  review: ProjectModelNode["review"];
  freshness: ProjectModelNode["freshness"];
  evidence: string[];
}

const norm = (node: ProjectModelNode): ProjectNorm | undefined => node.body.kind !== "inline" ? undefined : {
  id: node.id, title: node.title, text: node.body.text, kind: node.kind, review: node.review, freshness: node.freshness,
  evidence: node.evidence.map((entry) => entry.path)
};

export async function listProjectNorms(store: ProjectStore): Promise<ProjectNorm[]> {
  const model = await store.readModel();
  return (model?.nodes ?? []).flatMap((node) => norm(node) ?? []);
}

export async function readProjectNorm(store: ProjectStore, id: string): Promise<ProjectNorm> {
  const found = (await listProjectNorms(store)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Project norm '${id}' is not an editable inline norm.`);
  return found;
}

/** An unchanged body is a confirmation; a changed body needs verification against its sources. */
export async function writeProjectNorm(store: ProjectStore, id: string, text: string): Promise<void> {
  const model = await store.readModel();
  const node = model?.nodes.find((candidate) => candidate.id === id);
  if (!model || !node) throw new Error(`Project norm '${id}' is missing.`);
  if (node.body.kind !== "inline") throw new Error(`Project norm '${id}' is a document; edit its file instead.`);
  const changed = node.body.text.trim() !== text.trim();
  node.body = { kind: "inline", text };
  node.review = changed ? "edited" : "accepted";
  node.freshness = changed ? "needs_verification" : "current";
  await store.updateProject(model, model.revision);
}
