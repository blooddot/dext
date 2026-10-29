import type { KnowledgeBody } from "../contracts/projectKnowledge.js";
import type { ProjectModelNode } from "../contracts/projectModel.js";

export function knowledgeText(node: ProjectModelNode, documents: ReadonlyMap<string, string> = new Map()): string | undefined {
  return node.body.kind === "inline" ? node.body.text : documents.get(node.body.path);
}

/** AI candidates never silently overwrite reviewed norm bodies. */
export function replaceKnowledgeBody(node: ProjectModelNode, body: KnowledgeBody, actor: "user" | "ai"): ProjectModelNode {
  if (actor === "ai" && (node.review === "accepted" || node.review === "edited")) throw new Error(`Reviewed Knowledge '${node.id}' requires an explicit update proposal.`);
  return { ...node, body, review: actor === "user" ? "edited" : "draft", freshness: "needs_verification" };
}
