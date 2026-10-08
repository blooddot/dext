export type ResourceKind = "api" | "mcp" | "rule" | "skill" | "file";
export type ResourceScope = "project" | "global";

export const RESOURCE_LABELS: Record<ResourceKind, string> = { api: "API", mcp: "MCP", rule: "Rule", skill: "Skill", file: "File" };
export const RESOURCE_ICONS: Record<ResourceKind, string> = { api: "symbol-method", mcp: "plug", rule: "law", skill: "book", file: "file" };
export const RESOURCE_DIRECTORIES: Record<ResourceKind, string> = { api: "api", mcp: "mcp", rule: "rules", skill: "skills", file: "" };

export interface ResourceDocument {
  name: string;
  content: string;
  files?: ResourceFile[];
}

export interface ResourceFile {
  /** Relative to .dext/ (Project) or the global resource root. */
  path: string;
  content: string;
}

export interface ResourceTarget extends ResourceDocument {
  /** Path relative to the resource type's project/global directory. */
  path: string;
}

export interface ResourceSession {
  type: ResourceKind;
  scope: ResourceScope;
  target?: ResourceTarget;
  draft?: ResourceDocument;
  saved?: boolean;
}

export function resourceFileName(type: ResourceKind, name: string): string {
  if (type === "api") {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name)) throw new Error("Invalid API name.");
    return `${name.replaceAll(".", "/")}.ts`;
  }
  if (type === "file") {
    const normalized = name.trim().replaceAll("\\", "/");
    resourcePathSegments(type, normalized);
    return normalized;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("Invalid resource name.");
  return type === "skill" ? `${name}/SKILL.md` : type === "mcp" ? `${name}.jsonc` : name.endsWith(".md") ? name : `${name}.md`;
}

export function resourcePathSegments(type: ResourceKind, path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part) || Array.from(part).some((character) => character.charCodeAt(0) < 32))) throw new Error("Invalid resource path.");
  const valid = type === "file" ? true : type === "api" ? path.endsWith(".ts") : type === "mcp" ? parts.length === 1 && /\.jsonc?$/.test(path)
    : type === "skill" ? parts.length >= 2 && parts.at(-1) === "SKILL.md" : path.endsWith(".md");
  if (!valid) throw new Error("The selected file does not match the resource type.");
  return parts;
}

export function resourcePrompt(resource: ResourceSession, input: string): string {
  const current = resource.draft ?? resource.target;
  return [
    `Generate one complete Dext ${RESOURCE_LABELS[resource.type]} resource and its supporting files. Do not write files; return a draft for review.`,
    'Return exactly one JSON object with string fields name and content, and an optional files array of { "path": "rules/example.md", "content": "complete file content" }, without markdown fences or commentary. name/content describe the primary resource; files contains only supporting files.',
    `Save scope: ${resource.scope}. Supporting paths are relative to ${resource.scope === "project" ? ".dext/" : "the global resource root"}, without that prefix. Only rules/, templates/, and skills/ paths are allowed. Return complete contents for every new or changed supporting file. Preserve existing supporting files; omitting one does not delete it.`,
    'Extract reusable policies and operation-specific instructions into rules/*.md instead of embedding long rule strings in API input. Reference these through rules: ["example.md"] (relative to the rules directory, not ".dext/rules/example.md"). Include each new rule in files. Reuse existing rules only after verifying they exist; do not overwrite unrelated rules.',
    'Include static templates and skill supporting documents in files when needed. Do not generate code that creates or rewrites these files at runtime. Keep ordinary task input and dynamic values in the API.',
    resource.scope === "project"
      ? 'Reference template files by workspace-relative source paths, e.g. source: ".dext/templates/example.md".'
      : 'Rules and skills can be resolved from global resources. template() source must be inside the workspace: do not reference a global template as if it were a project .dext/templates file.',
    resource.type === "file" ? "name is a safe workspace-relative file path. content is the complete file content, preserving the file's format and extension."
      : resource.type === "api" ? "name is a dotted API id. content is a TypeScript module exporting main, for example export async function main(input: string): Promise<AskResult> { return await ask({ input }); } — result types such as AskResult are exported by the dext module rather than declared globally, so import the ones the signature uses as types: import { ask, type AskResult } from \"dext\";."
      : resource.type === "mcp" ? "content is a complete JSONC MCP manifest with name, transport (stdio or http), command/args or url, and a tools allowlist array. Preserve existing tool schemas, auth and other settings unless the user requests changes. Credentials must be environment/SecretStorage references."
        : resource.type === "skill" ? "name is a safe directory name. content is a complete SKILL.md."
          : "name is a safe markdown filename. content is policy markdown.",
    ...(resource.target ? [`Keep the existing resource name exactly: ${resource.target.name}`] : []),
    ...(current ? ["Current draft/document:", JSON.stringify(current)] : []),
    "This resource selection and current document take precedence over earlier resources discussed in this conversation.",
    "User request:", input
  ].join("\n\n");
}

/** Validate model output before any path reaches the filesystem. */
export function resourceFiles(value: unknown): ResourceFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("A resource may include up to 32 supporting files.");
  const paths = new Set<string>();
  let size = 0;
  return value.map((file: unknown) => {
    if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string"
      || !("content" in file) || typeof file.content !== "string") throw new Error("Supporting files need a path and content.");
    const parts = resourcePathSegments("file", file.path);
    if (parts.length < 2 || !["rules", "templates", "skills"].includes(parts[0]!)
      || (parts[0] === "rules" && !file.path.endsWith(".md"))
      || parts.some((part) => /[<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`Invalid supporting file path: ${file.path}`);
    }
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate supporting file: ${file.path}`);
    paths.add(key);
    size += file.content.length;
    if (!file.content.trim() || file.content.length > 200_000 || size > 1_000_000) throw new Error("Supporting files are empty or too large.");
    return { path: file.path, content: file.content };
  });
}

/** Older single-file responses and partial revisions retain their companions. */
export function mergeResourceFiles(current: ResourceFile[] | undefined, next: unknown): ResourceFile[] {
  const merged = new Map(resourceFiles(current).map((file) => [file.path.toLowerCase(), file]));
  for (const file of resourceFiles(next)) {
    const key = file.path.toLowerCase();
    merged.set(key, { ...file, path: merged.get(key)?.path ?? file.path });
  }
  return resourceFiles([...merged.values()]);
}
