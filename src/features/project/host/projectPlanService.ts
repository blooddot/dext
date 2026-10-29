import { resolve, normalize } from "node:path";
import type { PlanProjectContext, ProjectBasis, ProjectImpact } from "../../../shared/contracts/planProject.js";
import type { ProjectPlanPort, ProjectPlanRead, ProjectPlanRequest } from "../contracts/projectPlan.js";
import { parseProjectImpact, planSemanticContent } from "../knowledge/projectPlan.js";
import { projectReferenceOccurrences } from "../knowledge/projectReference.js";
import { type ProjectStore, projectContentHash, type ProjectLegacySnapshot } from "./persistence/projectStore.js";

interface Entry { id: string; locator: string; content: unknown; paths: string[]; names: string[]; global: boolean; links?: string[]; diagnostic?: string; writeTargets?: Array<{ target: string; id: string; beforeHash: string }> }

/** Relevant norms sent to Plan and to the final review. Relations and write hashes
 * ride along with each node, so a handful of large norms already needs this much. */
const GROUNDING_BUDGET = 24_000;

export function projectWorkspaceKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function entries(snapshot: ProjectLegacySnapshot): Entry[] {
  const result: Entry[] = [];
  const add = (id: string, locator: string, content: unknown, paths: string[] = [], names: string[] = [], global = false): void => {
    const file = snapshot.files.find(file => file.path === locator.split("#")[0]);
    const value = content as Record<string, unknown>;
    const links = ["relatedIds", "dependsOn", "relatedContextIds", "contextIds", "scope"].flatMap(key => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((id): id is string => typeof id === "string") : []);
    result.push({ id, locator, content, paths, names, global, links, ...(file ? { writeTargets: [{ target: file.path, id, beforeHash: file.hash }] } : {}) });
  };
  for (const object of snapshot.objects) {
    const file = snapshot.files.find(file => file.path.startsWith(".dext/objects/") && (JSON.parse(file.raw) as { id: string }).id === object.id)!;
    add(object.id, file.path, object, object.paths, [object.canonicalName, object.displayName ?? "", ...object.aliases]);
  }
  const intent = snapshot.intent;
  if (intent) {
    const root = ".dext/project-intent.json";
    add("brief", `${root}#/brief`, intent.brief, [], [], true);
    for (const collection of ["capabilities", "contexts", "flows", "terms", "constraints", "decisions"] as const) {
      for (const item of intent[collection]) {
        const paths = "sourceFiles" in item ? item.sourceFiles ?? [] : [];
        const names = "canonicalName" in item ? [item.canonicalName, item.displayName ?? ""] : [];
        // Constraints/decisions apply conservatively, even when no path mentions them.
        add(item.id, `${root}#/${collection}/${encodeURIComponent(item.id)}`, item, paths, names, collection === "constraints" || collection === "decisions");
      }
    }
    if (intent.c4) add("c4", `${root}#/c4`, intent.c4, [], [], true);
  }
  if (snapshot.architecture) {
    for (const collection of ["rules", "decisions"] as const) for (const item of snapshot.architecture[collection]) {
      add(item.id, `.dext/architecture.json#/${collection}/${encodeURIComponent(item.id)}`, item, [], [], true);
    }
  }
  return result;
}

export class ProjectPlanService implements ProjectPlanPort {
  readonly workspaceKey: string;
  constructor(private readonly store: ProjectStore, workspace: string) {
    this.workspaceKey = projectWorkspaceKey(workspace);
  }

  async readPlanContext(request: ProjectPlanRequest): Promise<ProjectPlanRead> {
    const empty: ProjectPlanRead = { availability: "absent", workspaceKey: this.workspaceKey, basis: [], grounding: "", diagnostics: [], omitted: [] };
    if (projectWorkspaceKey(request.workspaceKey) !== this.workspaceKey) return { ...empty, availability: "unavailable", diagnostics: ["Project workspace does not match this Plan."] };
    try {
      // A native document must never silently fall back to stale legacy files.
      const model = await this.store.readModel();
      const all: Entry[] = [];
      if (model) {
        for (const node of model.nodes) {
          const text = node.body.kind === "inline" ? node.body.text : await this.store.readStrict(node.body.path);
          if (text === undefined) throw new Error(`Knowledge document for '${node.id}' is missing.`);
          if (node.body.kind === "document" && projectContentHash(text) !== node.body.contentHash) throw new Error(`Knowledge document for '${node.id}' changed; review its content hash.`);
          const relations = model.relations.filter(edge => edge.from === node.id || edge.to === node.id);
          all.push({ id: node.id, locator: `.dext/project/model.json#/nodes/${encodeURIComponent(node.id)}`, content: { ...node, text, relations }, paths: node.paths, names: [node.title, node.canonicalName], global: ["project", "constraint", "decision", "contract", "architecture"].includes(node.kind),
            links: relations.flatMap(edge => [edge.from, edge.to]),
            ...(node.freshness !== "current" || node.review === "rejected" ? { diagnostic: `Norm '${node.id}' requires review (${node.review}/${node.freshness}).` } : {}),
            writeTargets: [{ target: "node", id: node.id, beforeHash: projectContentHash(JSON.stringify(node)) }, ...relations.map(edge => ({ target: "relation", id: edge.id, beforeHash: projectContentHash(JSON.stringify(edge)) }))]
          });
        }
      } else {
        const snapshot = await this.store.readLegacySnapshot();
        if (!snapshot.files.length) return empty;
        all.push(...entries(snapshot));
      }
      if (!all.length) return { ...empty, availability: "unavailable", diagnostics: ["Project contains no usable normative content."] };
      const refs = new Set(projectReferenceOccurrences(request.input).map(item => item.reference.objectId));
      const selected = all.filter(entry => entry.global || refs.has(entry.id)
        || entry.names.some(name => name.length > 1 && request.input.toLowerCase().includes(name.toLowerCase()))
        || entry.paths.some(path => request.input.includes(path) || request.paths?.some(candidate => candidate === path || candidate.startsWith(path.replace(/\/\*\*$/, "") + "/"))));
      const diagnostics: string[] = [];
      const selectedIds = new Set(selected.flatMap(entry => [entry.id, ...entry.links ?? []]));
      for (const entry of all) if (selectedIds.has(entry.id) && !selected.includes(entry)) selected.push(entry);
      for (const entry of selected) if (entry.diagnostic) diagnostics.push(entry.diagnostic);
      for (const id of refs) if (all.filter(entry => entry.id === id).length !== 1) diagnostics.push(`Reference '${id}' is missing or ambiguous.`);
      if (!selected.length) diagnostics.push("No relevant Project norms matched; impact is unknown.");
      const basis: ProjectBasis[] = selected.map(entry => ({ locator: entry.locator, id: entry.id, kind: "object", hash: projectContentHash(JSON.stringify(entry.content)) }));
      // Include selection inputs and selectors, not unrelated object bodies.
      basis.push({ locator: "project:applicability", id: JSON.stringify({ input: request.input, paths: request.paths ?? [] }), kind: "applicability", hash: projectContentHash(JSON.stringify(all.map(({ id, locator, paths, names, global }) => ({ id, locator, paths, names, global })))) });
      const omitted: string[] = [];
      const parts: string[] = [];
      let length = 0;
      for (const entry of selected) {
        const text = JSON.stringify({ id: entry.id, locator: entry.locator, value: entry.content, writeTargets: entry.writeTargets });
        if (length + text.length + 1 > GROUNDING_BUDGET) { omitted.push(entry.locator); continue; }
        parts.push(text); length += text.length + 1;
      }
      if (omitted.length) diagnostics.push("Grounding is truncated; omitted norms require explicit reading before a none assessment.");
      return { ...empty, availability: "ready", basis, grounding: parts.join("\n"), omitted, diagnostics };
    } catch (error) {
      return { ...empty, availability: "unavailable", diagnostics: [error instanceof Error ? error.message : String(error)] };
    }
  }

  bindPlan(read: ProjectPlanRead, planPath: string, document: string, impact?: ProjectImpact): PlanProjectContext {
    const parsed = parseProjectImpact(document);
    const candidate = impact ?? (parsed.status === "parsed" ? parsed.impact : undefined);
    const known = new Set(read.basis.filter(item => item.kind !== "applicability").map(item => item.id));
    // Truncated or flagged grounding cannot prove 'none', but a change still names what it touches.
    const complete = !read.diagnostics.length && !read.omitted.length;
    const valid = read.availability === "ready" && candidate && (complete || candidate.assessment !== "none") && candidate.refs.every(id => known.has(id));
    return {
      workspaceKey: read.workspaceKey, planPath: normalize(planPath).replaceAll("\\", "/"),
      documentHash: projectContentHash(planSemanticContent(document)), fileHash: projectContentHash(document),
      availability: read.availability, assessment: valid ? candidate.assessment : "unknown",
      reason: valid ? candidate.reason : [...read.diagnostics, parsed.status === "invalid" ? parsed.diagnostic : "Project impact has not been established."].join(" "),
      basis: read.basis, reviewStatus: valid && candidate.assessment === "none" ? "current" : "pending"
    };
  }

  async validatePlan(context: PlanProjectContext, document: string): Promise<{ valid: boolean; diagnostics: string[] }> {
    const diagnostics: string[] = [];
    if (context.workspaceKey !== this.workspaceKey) diagnostics.push("Plan belongs to another workspace.");
    if (projectContentHash(planSemanticContent(document)) !== context.documentHash) diagnostics.push("Plan document changed; review the design before resuming.");
    const selector = context.basis.find(item => item.kind === "applicability");
    if (context.availability === "ready" && !selector) diagnostics.push("Project applicability basis is missing.");
    if (selector) {
      try {
        const request = JSON.parse(selector.id) as { input: string; paths: string[] };
        const current = await this.readPlanContext({ ...request, workspaceKey: context.workspaceKey });
        if (current.availability !== "ready" || JSON.stringify(current.basis) !== JSON.stringify(context.basis)) diagnostics.push("Relevant Project norms or applicability changed.");
      } catch { diagnostics.push("Project basis cannot be read."); }
    }
    return { valid: !diagnostics.length, diagnostics };
  }
}
