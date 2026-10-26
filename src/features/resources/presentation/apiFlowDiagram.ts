import type { ApiFlow, ApiFlowFunction, ApiFlowIssue } from "../../workflow/contracts/apiFlow.js";

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

/** Entity-escape a Mermaid label so user text cannot become markup. */
function mermaidText(value: string): string {
  return value.replace(/&/g, "#amp;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/"/g, "#quot;");
}

function nodeShape(fn: ApiFlowFunction, label: string): string {
  // Entry points read as endpoints, wrappers as the one built-in call they carry.
  if (fn.exported) return `(["${label}"])`;
  if (fn.apiCalls.length) return `[["${label}"]]`;
  return `["${label}"]`;
}

/**
 * The Mermaid `flowchart LR` source for a flow. Node ids are generated (`n0`,
 * `n1`, …) so the output is stable across runs and independent of function
 * names; edges follow function order and each function's source call order.
 */
export function renderApiFlowMermaid(flow: ApiFlow): string {
  const ids = new Map(flow.functions.map((fn, index) => [fn.name, `n${index}`]));
  const violation = new Set(flow.issues.map((issue) => issue.function));
  const lines = ["flowchart LR"];
  flow.functions.forEach((fn, index) => {
    const suffix = [fn.exported ? "entry" : "", ...fn.apiCalls.map((call) => call.tag), fn.unused ? "unused" : ""].filter(Boolean);
    const label = mermaidText([`${fn.name} L${fn.line}`, ...suffix].join(" · "));
    lines.push(`  n${index}${nodeShape(fn, label)}`);
  });
  const seen = new Set<string>();
  for (const edge of flow.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    const key = `${edge.from}\u0000${edge.to}`;
    if (!from || !to || seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${from} --> ${to}`);
  }
  lines.push(
    "  classDef entry stroke-width:2px",
    "  classDef wrapper stroke-width:2px",
    "  classDef helper stroke-width:1px",
    "  classDef unused stroke-dasharray:4",
    "  classDef violation stroke:#d13438,stroke-width:2px"
  );
  flow.functions.forEach((fn, index) => {
    const className = fn.exported ? "entry" : fn.apiCalls.length ? "wrapper" : "helper";
    lines.push(`  class n${index} ${className}`);
    if (fn.unused) lines.push(`  class n${index} unused`);
    if (violation.has(fn.name)) lines.push(`  class n${index} violation`);
  });
  return lines.join("\n");
}

function renderIssue(issue: ApiFlowIssue): string {
  return `<li data-api-flow-issue="${issue.rule}"><strong>${escapeHtml(issue.function)}</strong> (line ${issue.line}): `
    + `${escapeHtml(issue.message)} ${escapeHtml(issue.suggestion)}</li>`;
}

function renderFunction(fn: ApiFlowFunction): string {
  const roles = [
    fn.exported ? "entry" : "",
    fn.apiCalls.length ? `wrapper: ${fn.apiCalls.map((call) => call.tag).join(", ")}` : "helper",
    fn.unused ? "unused" : ""
  ].filter(Boolean);
  const calls = fn.calls.length ? ` → ${fn.calls.join(", ")}` : "";
  return `<li data-api-flow-function="${escapeHtml(fn.name)}"><code>${escapeHtml(fn.name)}</code> L${fn.line} `
    + `<span class="resource-api-flow-role">${escapeHtml(roles.join(" · "))}</span>${escapeHtml(calls)}</li>`;
}

/**
 * The Execution flow section for an API detail page. It is a shell only: the
 * host never runs Mermaid, so `apiFlow.js` renders the SVG in the Webview and
 * updates the state. The source and function list remain usable if that fails.
 */
export function renderApiFlow(flow: ApiFlow | undefined, name: string): string {
  if (!flow?.functions.length) return "";
  const issues = flow.issues.filter((issue) => issue.severity === "error");
  return `<figure class="resource-api-flow" data-api-flow data-api-flow-state="loading">`
    + `<figcaption>Execution flow</figcaption>`
    + `<p class="resource-api-flow-status" data-api-flow-status role="status">Rendering execution flow…</p>`
    + `<div class="resource-api-flow-preview" data-api-flow-preview aria-label="Execution flow for ${escapeHtml(name)}"></div>`
    + (issues.length
      ? `<div class="resource-api-flow-issues" role="alert"><h3>Function rule issues</h3><ul>${issues.map(renderIssue).join("")}</ul></div>`
      : "")
    + `<details class="resource-api-flow-source" data-api-flow-source-details><summary>Mermaid source</summary>`
    + `<pre><code data-api-flow-source>${escapeHtml(renderApiFlowMermaid(flow))}</code></pre></details>`
    + `<details class="resource-api-flow-functions"><summary>Functions (${flow.functions.length})</summary>`
    + `<ul class="resource-api-flow-list">${flow.functions.map(renderFunction).join("")}</ul></details>`
    + `</figure>`;
}
