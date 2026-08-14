import type { OutputKind } from "./core/types.js";

const RESULT_KINDS = new Set<OutputKind>([
  "chat", "explain", "edit", "review", "apply", "terminal", "print", "text", "code", "plan", "patch"
]);

export interface AgentMessageDetail {
  text: string;
  tone: "error" | "warning" | "info";
  meta?: string;
}

export interface AgentMessageChange {
  uri: string;
  before: string;
  after: string;
}

export interface AgentMessageReference {
  uri: string;
  location: string;
  symbol: string;
  content: string;
}

export interface AgentMessageSection {
  title: string;
  text: string;
  tone: "normal" | "error" | "muted";
  code: boolean;
}

export interface AgentMessagePresentation {
  structured: boolean;
  kind: string;
  title: string;
  text: string;
  meta: string[];
  details: AgentMessageDetail[];
  changes: AgentMessageChange[];
  references: AgentMessageReference[];
  sections: AgentMessageSection[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function status(value: unknown): string {
  const labels: Record<string, string> = {
    pass: "Passed",
    warning: "Warning",
    fail: "Failed",
    applied: "Applied",
    unchanged: "Unchanged",
    conflict: "Conflict",
    succeeded: "Succeeded",
    failed: "Failed",
    timed_out: "Timed out"
  };
  return labels[string(value)] ?? string(value);
}

function parsedResult(text: string): Record<string, unknown> | undefined {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = record(JSON.parse(source));
    const value = parsed?.kind === "dext-result" ? record(parsed.value) : parsed;
    return value && RESULT_KINDS.has(value.kind as OutputKind) ? value : undefined;
  } catch {
    return undefined;
  }
}

function findingDetails(value: unknown): AgentMessageDetail[] {
  return array(value).flatMap((item) => {
    const finding = record(item);
    const text = string(finding?.message);
    if (!text) return [];
    const severity = string(finding?.severity);
    const tone = severity === "error" || severity === "warning" ? severity : "info";
    const uri = string(finding?.uri);
    const line = typeof finding?.line === "number" ? `:${finding.line}` : "";
    return [{ text, tone, ...(uri ? { meta: `${uri}${line}` } : {}) }];
  });
}

function patchChanges(value: unknown): AgentMessageChange[] {
  return array(value).flatMap((item) => {
    const change = record(item);
    const uri = string(change?.uri);
    const before = typeof change?.before === "string" ? change.before : undefined;
    const after = typeof change?.after === "string" ? change.after : undefined;
    return uri && before !== undefined && after !== undefined ? [{ uri, before, after }] : [];
  });
}

function location(value: unknown): string {
  const range = record(value);
  const start = record(range?.start);
  const end = record(range?.end);
  if (typeof start?.line !== "number") return "";
  const first = start.line + 1;
  const last = typeof end?.line === "number" ? end.line + 1 : first;
  return first === last ? `Line ${first}` : `Lines ${first}-${last}`;
}

function codeReferences(value: unknown): AgentMessageReference[] {
  return array(value).flatMap((item) => {
    const reference = record(item);
    const uri = string(reference?.uri);
    if (!uri) return [];
    return [{
      uri,
      location: location(reference?.range),
      symbol: string(reference?.symbol),
      content: typeof reference?.content === "string" ? reference.content : ""
    }];
  });
}

function section(title: string, value: unknown, options: Partial<Pick<AgentMessageSection, "tone" | "code">> = {}): AgentMessageSection[] {
  const text = typeof value === "string" ? value : "";
  return text ? [{ title, text, tone: options.tone ?? "normal", code: options.code ?? false }] : [];
}

export function presentAgentMessage(raw: string): AgentMessagePresentation {
  const value = parsedResult(raw);
  if (!value) return {
    structured: false,
    kind: "message",
    title: "",
    text: raw,
    meta: [],
    details: [],
    changes: [],
    references: [],
    sections: []
  };

  const kind = value.kind as OutputKind;
  const patch = record(value.patch);
  const changes = patchChanges(kind === "edit" ? patch?.changes : value.changes);
  const references = codeReferences(value.files);
  const findings = findingDetails(value.findings);
  const meta: string[] = [];
  let title = "Result";
  let text = string(value.summary) || string(value.text);
  let details = findings;
  let sections: AgentMessageSection[] = [];

  if (kind === "edit") {
    title = "Edit proposal";
    if (changes.length) meta.push(count(changes.length, "file"));
    if (!text) text = string(patch?.title);
  } else if (kind === "review") {
    title = "Review";
    const state = status(value.status);
    if (state) meta.push(state);
    if (findings.length) meta.push(count(findings.length, "finding"));
  } else if (kind === "explain") {
    title = "Explanation";
    if (references.length) meta.push(count(references.length, "reference"));
  } else if (kind === "apply") {
    title = "Apply changes";
    const state = status(value.status);
    if (state) meta.push(state);
    if (references.length) meta.push(count(references.length, "file"));
  } else if (kind === "terminal") {
    title = "Terminal";
    text = string(value.command) || text;
    const state = status(value.status);
    if (state) meta.push(state);
    if (typeof value.exit_code === "number") meta.push(`Exit ${value.exit_code}`);
    if (typeof value.duration_ms === "number") meta.push(`${value.duration_ms} ms`);
    sections = [
      ...section("Working directory", value.cwd, { tone: "muted" }),
      ...section("Standard output", value.stdout, { code: true }),
      ...section("Error output", value.stderr, { tone: "error", code: true })
    ];
  } else if (kind === "patch") {
    title = "Patch";
    text = string(value.title) || text;
    if (changes.length) meta.push(count(changes.length, "file"));
  } else if (kind === "plan") {
    title = "Plan";
    text = string(value.title) || text;
    details = array(value.steps).flatMap((item) => {
      const step = record(item);
      const stepTitle = string(step?.title);
      const detail = string(step?.detail);
      const state = status(step?.status);
      return stepTitle ? [{ text: detail ? `${stepTitle}: ${detail}` : stepTitle, tone: "info" as const, meta: state }] : [];
    });
    if (details.length) meta.push(count(details.length, "step"));
  } else if (kind === "code") {
    title = "Generated code";
    text = string(value.title) || "Code generation completed.";
    const language = string(value.language);
    if (language) meta.push(language);
    sections = section("Code", value.code, { code: true });
  } else if (kind === "chat") {
    title = "Response";
  } else if (kind === "print") {
    title = "Printed output";
    const label = string(value.label);
    if (label) meta.push(label);
  } else if (kind === "text") {
    title = "Text result";
  }

  return { structured: true, kind, title, text, meta, details, changes, references, sections };
}

export function agentMessageCopyText(presentation: AgentMessagePresentation): string {
  if (!presentation.structured) return presentation.text;
  const heading = [presentation.title, ...presentation.meta].filter(Boolean).join(" · ");
  const changes = presentation.changes.map((change) => `${change.uri}\n- ${change.before}\n+ ${change.after}`);
  const references = presentation.references.map((reference) => [
    reference.uri,
    [reference.location, reference.symbol].filter(Boolean).join(" · "),
    reference.content
  ].filter(Boolean).join("\n"));
  const sections = presentation.sections.map((item) => `${item.title}\n${item.text}`);
  return [heading, presentation.text, ...presentation.details.map((detail) => [detail.meta, detail.text].filter(Boolean).join(" · ")), ...changes, ...references, ...sections]
    .filter(Boolean)
    .join("\n");
}
