export type ResourceKind = "api" | "mcp" | "rule" | "skill";
export type ResourceScope = "project" | "global";

export const RESOURCE_LABELS: Record<ResourceKind, string> = { api: "API", mcp: "MCP", rule: "Rule", skill: "Skill" };
export const RESOURCE_ICONS: Record<ResourceKind, string> = { api: "symbol-method", mcp: "plug", rule: "law", skill: "book" };
export const RESOURCE_DIRECTORIES: Record<ResourceKind, string> = { api: "api", mcp: "mcp", rule: "rules", skill: "skills" };

export interface ResourceDocument {
  name: string;
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
    return `${name.replaceAll(".", "/")}.dx`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("Invalid resource name.");
  return type === "skill" ? `${name}/SKILL.md` : type === "mcp" ? `${name}.jsonc` : name.endsWith(".md") ? name : `${name}.md`;
}

export function resourcePathSegments(type: ResourceKind, path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part) || Array.from(part).some((character) => character.charCodeAt(0) < 32))) throw new Error("Invalid resource path.");
  const valid = type === "api" ? path.endsWith(".dx") : type === "mcp" ? parts.length === 1 && /\.jsonc?$/.test(path)
    : type === "skill" ? parts.length >= 2 && parts.at(-1) === "SKILL.md" : path.endsWith(".md");
  if (!valid) throw new Error("The selected file does not match the resource type.");
  return parts;
}

export function resourcePrompt(resource: ResourceSession, input: string): string {
  const current = resource.draft ?? resource.target;
  return [
    `Generate one complete Dext ${RESOURCE_LABELS[resource.type]} resource. Do not write files; return a draft for review.`,
    "Return exactly one JSON object with string fields name and content, without markdown fences or commentary.",
    resource.type === "api" ? "name is a dotted API id. content is valid Dext .dx source containing main with typed parameters and a result return annotation, for example def main(input: str) -> AskResult: followed by return ask(input=input)."
      : resource.type === "mcp" ? "content is a complete JSONC MCP manifest with name, transport (stdio or http), command/args or url, and a tools allowlist array. Preserve existing tool schemas, auth and other settings unless the user requests changes. Credentials must be environment/SecretStorage references."
        : resource.type === "skill" ? "name is a safe directory name. content is a complete SKILL.md."
          : "name is a safe markdown filename. content is policy markdown.",
    ...(resource.target ? [`Keep the existing resource name exactly: ${resource.target.name}`] : []),
    ...(current ? ["Current draft/document:", JSON.stringify(current)] : []),
    "This resource selection and current document take precedence over earlier resources discussed in this conversation.",
    "User request:", input
  ].join("\n\n");
}
