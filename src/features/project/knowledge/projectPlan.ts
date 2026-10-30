import { projectImpactSchema, type ProjectImpact } from "../../../shared/contracts/planProject.js";

export type ProjectImpactParse =
  | { status: "missing" }
  | { status: "invalid"; diagnostic: string }
  | { status: "parsed"; impact: ProjectImpact };

/** Mask code samples without changing offsets; examples cannot become protocol messages. */
function maskCode(source: string): string {
  let fence: { marker: string; length: number } | undefined;
  return source.split(/(?<=\n)/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
      return line.replace(/[^\r\n]/g, " ");
    }
    if (match) {
      fence = { marker: match[1]![0]!, length: match[1]!.length };
      return line.replace(/[^\r\n]/g, " ");
    }
    if (/^(?: {4}|\t)/.test(line)) return line.replace(/[^\r\n]/g, " ");
    return line.replace(/(`+)([^\r\n]*?)\1/g, match => " ".repeat(match.length));
  }).join("");
}

/** Norm ids named by a task line as `norms: a,b`; code samples cannot name a norm. */
export function planTaskNorms(document: string): Set<string> {
  const ids = new Set<string>();
  for (const line of maskCode(document.replace(/\r\n/g, "\n")).split("\n")) {
    if (!/^\d+\. \[[ xX]\]/.test(line)) continue;
    for (const match of line.matchAll(/norms:\s*([\w.:/-]+(?:,[\w.:/-]+)*)/g)) {
      for (const id of match[1]!.split(",")) ids.add(id.replace(/[.:;]+$/, ""));
    }
  }
  return ids;
}

const marker = /<!--\s*dext-project-impact\s*:\s*([\s\S]*?)-->/g;

export function parseProjectImpact(document: string): ProjectImpactParse {
  const visible = maskCode(document);
  const matches = [...visible.matchAll(marker)];
  if (!matches.length) return /<!--\s*dext-project-impact\b/.test(visible)
    ? { status: "invalid", diagnostic: "Unterminated Project impact summary." } : { status: "missing" };
  if (matches.length !== 1) return { status: "invalid", diagnostic: "Multiple Project impact summaries." };
  try {
    const match = matches[0]!;
    const raw = document.slice(match.index, match.index + match[0].length);
    const payload = /<!--\s*dext-project-impact\s*:\s*([\s\S]*?)-->/.exec(raw)![1]!;
    const impact = projectImpactSchema.parse(JSON.parse(payload));
    return { status: "parsed", impact };
  } catch {
    return { status: "invalid", diagnostic: "Invalid Project impact summary; review is required." };
  }
}

/** Checkbox progress and host summaries do not change task semantics; code samples do. */
export function planSemanticContent(document: string): string {
  const normalized = document.replace(/\r\n/g, "\n");
  const visible = maskCode(normalized);
  const ranges = [...visible.matchAll(marker)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  let result = normalized;
  for (const range of ranges.reverse()) result = result.slice(0, range.start) + result.slice(range.end);
  const masked = maskCode(result).split("\n");
  return result.split("\n").map((line, index) => {
    const visibleLine = masked[index] ?? "";
    return /^\d+\. \[[ xX]\]/.test(visibleLine) ? line.replace(/^(\d+\. )\[[ xX]\]/, "$1[ ]") : line;
  }).join("\n").trim();
}
