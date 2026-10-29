import { z } from "zod";
import { projectModelSchema, projectModelNodeSchema, type ProjectModel } from "../contracts/projectModel.js";
import type { ProjectInitializationOutput, ProjectInitializationProgressListener } from "../contracts/lifecycle.js";
import { parseProjectModel, projectModelIntent } from "../knowledge/projectModel.js";
import { reconcileNativeProject } from "../knowledge/projectModelEvolution.js";
import { compareProjectEvidencePaths, type ProjectAiProvider } from "./generation/projectAiGeneration.js";
import { type ProjectStore, projectContentHash, type ProjectFileHost } from "./persistence/projectStore.js";
import { commitProjectMigration } from "./persistence/projectMigration.js";

export type ProjectBootstrapRoute = "existing" | "legacy" | "documents" | "code" | "empty";
const durable = (path: string) => /(?:^|\/)(?:adr|architecture|contracts?|design|specifications?)(?:\/|[.-])/i.test(path) && /\.md$/i.test(path)
  && !/(?:^|\/)(?:plans|vendor|node_modules|dist)(?:\/|$)|\.plan\.md$|(?:readme|changelog|roadmap)/i.test(path);

export function detectProjectBootstrap(input: { model?: ProjectModel; legacy: boolean; paths: readonly string[] }): ProjectBootstrapRoute {
  if (input.model) return "existing";
  if (input.legacy) return "legacy";
  if (input.paths.some(durable)) return "documents";
  if (input.paths.some(path => /\.(?:[cm]?[jt]sx?|rs|py|go|java|kt|cs|cpp|c)$/i.test(path))) return "code";
  return "empty";
}

const checkpointSchema = z.object({ version: z.literal(1), fingerprint: z.string(), route: z.enum(["existing", "legacy", "documents", "code", "empty"]), stage: z.enum(["candidate", "committed"]), candidate: projectModelSchema }).strict();
export const PROJECT_BOOTSTRAP_CHECKPOINT_PATH = ".dext/project/bootstrap.checkpoint.json";

export async function readBootstrapCheckpoint(host: ProjectFileHost): Promise<{ stage: string; fraction: number } | undefined> {
  const raw = await (host.readFileStrict ? host.readFileStrict(PROJECT_BOOTSTRAP_CHECKPOINT_PATH) : host.readFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH));
  if (!raw) return undefined;
  try { const checkpoint = checkpointSchema.parse(JSON.parse(raw)); return checkpoint.stage === "candidate" ? { stage: `${checkpoint.route}:candidate`, fraction: 1 } : undefined; } catch { return undefined; }
}

/** Invoked only by an explicit Project initialization/update action, never Plan or query. */
export async function bootstrapProject(options: {
  name: string; host: ProjectFileHost; store: ProjectStore; paths: readonly string[];
  provider?: ProjectAiProvider; ai: string; signal: AbortSignal; progress: ProjectInitializationProgressListener;
}): Promise<ProjectInitializationOutput> {
  const { store, host, signal, progress } = options;
  signal.throwIfAborted();
  const model = await store.readModel();
  const legacy = model ? undefined : await store.readLegacySnapshot();
  const route = detectProjectBootstrap({ ...(model ? { model } : {}), legacy: Boolean(legacy?.files.length), paths: options.paths });
  progress({ phase: "preparing", fraction: 0, message: `Project initialization route: ${route}` });
  if (route === "legacy") {
    signal.throwIfAborted(); const migrated = await commitProjectMigration(host, legacy!);
    return { model: migrated, intent: projectModelIntent(migrated) };
  }
  const sources = new Map<string, string>(); let chars = 0;
  for (const path of [...options.paths].sort(compareProjectEvidencePaths)) {
    if (/(?:^|\/)(?:\.git|node_modules|dist|\.env(?:\.[^/]*)?|\.ssh|\.aws)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i.test(path) || /\.plan\.md$/.test(path)) continue;
    if (sources.size >= 100 || chars >= 80_000) break;
    const raw = await (host.readFileStrict ? host.readFileStrict(path) : host.readFile(path));
    if (raw === undefined || raw.includes("\0") || raw.length > 20_000 || chars + raw.length > 80_000) continue;
    sources.set(path, raw); chars += raw.length;
  }
  signal.throwIfAborted();
  const fingerprint = projectContentHash(JSON.stringify({ route, revision: model?.revision ?? null, documents: [...sources].map(([path, text]) => [path, projectContentHash(text)]), prompt: "project-bootstrap-1", schema: 1, ai: options.ai }));
  const rawCheckpoint = await (host.readFileStrict ? host.readFileStrict(PROJECT_BOOTSTRAP_CHECKPOINT_PATH) : host.readFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH));
  let resumed: ProjectModel | undefined;
  if (rawCheckpoint) {
    try { const saved = checkpointSchema.parse(JSON.parse(rawCheckpoint)); if (saved.fingerprint === fingerprint && saved.stage === "candidate") resumed = parseProjectModel(saved.candidate); } catch { /* Invalid candidate is never promoted. */ }
  }
  let candidate = resumed;
  if (!candidate) {
    if (route === "empty" || route === "documents") {
      candidate = { schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [projectModelNodeSchema.parse({ id: "project", kind: "project", title: options.name, canonicalName: options.name, body: { kind: "inline", text: "Project intent needs definition and review." }, review: "draft", freshness: "needs_verification" })] };
      if (route === "documents") for (const [path, content] of sources) if (durable(path)) candidate.nodes.push(projectModelNodeSchema.parse({ id: `document:${projectContentHash(path).slice(0, 20)}`, kind: "contract", title: path, canonicalName: path, body: { kind: "document", path, contentHash: projectContentHash(content) }, origin: "detected", review: "draft", freshness: "needs_verification" }));
      if (route === "documents" && candidate.nodes.length === 1) throw new Error("Durable documents exceed the read budget or could not be read; choose a smaller scope.");
    } else {
      if (!options.provider) throw new Error("Choose an available Project AI provider before importing code.");
      progress({ phase: "generating", fraction: 0, message: "Drafting goals, architecture, then responsibility boundaries…" });
      const response = await options.provider.generate({ prompt: [
        "Build a native Project normative model: first goals, then architecture, then modules/contracts and their explicit relationships. Do not mirror the directory tree.",
        "Read guidance before specifications, configuration and source evidence. Third-party sources are supporting evidence. All generated content is draft; retain accepted/edited content and relationships in the existing model.",
        "Do not create Plan nodes. Adopt durable documents in place rather than copying them. Return a JSON object matching the supplied schema. Evidence outside this bounded package is unknown.",
        JSON.stringify({ existing: model, sources: [...sources], omitted: options.paths.length - sources.size })
      ].join("\n\n"), responseSchema: z.toJSONSchema(projectModelSchema), inputHash: fingerprint, promptVersion: "project-bootstrap-1", attempt: 1, maxOutputTokens: 32_000 }, signal);
      candidate = parseProjectModel(JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()));
      candidate.nodes = candidate.nodes.map(node => ({ ...node, review: "draft", freshness: "needs_verification" }));
      candidate.relations = candidate.relations.map(edge => ({ ...edge, review: "draft", freshness: "needs_verification" }));
    }
    await host.writeFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH, JSON.stringify({ version: 1, route, fingerprint, stage: "candidate", candidate }));
  }
  signal.throwIfAborted();
  for (const [path, text] of sources) {
    const current = await (host.readFileStrict ? host.readFileStrict(path) : host.readFile(path));
    if (current !== text) throw new Error(`Project source changed during initialization: ${path}`);
  }
  progress({ phase: "saving", fraction: 0, message: "Validating the Project model and its baseline…" });
  const next = await store.updateProject(reconcileNativeProject(candidate, model), model?.revision ?? null);
  await host.writeFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH, JSON.stringify({ version: 1, route, fingerprint, stage: "committed", candidate: next }));
  return { model: next, intent: projectModelIntent(next, sources) };
}
