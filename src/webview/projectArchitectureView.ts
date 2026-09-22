import type { ArchitectureRule, ArchitectureViolation } from "../core/projectArchitecture.js";
import { archifyViewerBridgeScript, isTrustedHostMessage, isTrustedViewerMessage } from "../projectDiagramViewer.js";
export { archifyViewerBridgeScript };
import type { ProjectDiagramKind } from "../core/projectDiagram.js";
import type { ProjectEvidenceSummary } from "../core/projectAiGeneration.js";

export interface ProjectArchitectureDecision {
  id: string;
  title: string;
  detail: string;
}

export interface ProjectDiagramSummary {
  id: string;
  title: string;
  kind: ProjectDiagramKind;
  version: number;
  updatedAt: number;
  review?: string;
}

export interface DiagramRenderDetails {
  diagramId?: string;
  requestedVersion?: number;
  displayedVersion?: number;
  usedLastGood?: boolean;
  status?: string;
  issues?: readonly { code: string; message: string; severity: string }[];
  updatedAt?: number;
  error?: string;
}

/**
 * One diagram node as the page shows it after a click. Selecting a card never opens a file by
 * itself: the page renders these details and the reader chooses an evidence entry to open.
 */
export interface ProjectDiagramNodeDetail {
  id: string;
  label: string;
  description?: string;
  role?: string;
  semanticIds?: readonly string[];
  evidence: readonly { path: string; line?: number; note?: string }[];
  confidence?: number;
  review?: string;
  freshness?: string;
}

export interface ArchitectureViewInput {
  /** Everything the Archify viewer can display, architecture first. */
  diagrams: readonly ProjectDiagramSummary[];
  /** Preferred diagram; resolution is owned by the webview but actions always carry id + version. */
  selected?: ProjectDiagramSummary;
  /** True when no valid saved intent exists; saved diagrams stay viewable. */
  knowledgeUninitialized?: boolean;
  generating?: boolean;
  generationError?: string;
  engine?: { id: string; version: string; available: boolean; reason?: string };
  render?: DiagramRenderDetails;
  decisions?: readonly ProjectArchitectureDecision[];
  rules?: readonly ArchitectureRule[];
  violations?: readonly ArchitectureViolation[];
  baselineViolations?: readonly ArchitectureViolation[];
  /** Why declared rules could not be evaluated against a diagram. */
  rulesNote?: string;
  coverage?: readonly string[];
  /** What the last evidence read actually handed the model. */
  evidence?: ProjectEvidenceSummary;
}

/**
 * Self-contained on purpose: the same function renders the section on the server and inside the page
 * bridge, so a live update can never drift from the rendered page.
 */
export function evidenceSummaryHtml(summary: ProjectEvidenceSummary | undefined): string {
  if (!summary) return "";
  const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[character] ?? character);
  const counts = (byKind: Record<string, number>): string => Object.keys(byKind).sort().map((kind) => `${kind} ${byKind[kind]}`).join(" · ");
  const paths = (entries: readonly string[], limit: number): string => entries.slice(0, limit)
    .map((path) => `<button type="button" data-evidence-path="${esc(path)}">${esc(path)}</button>`).join("");
  const scope = summary.selection.scope.length ? summary.selection.scope.join(", ") : "built-in (README, documentation, manifests, source)";
  const read = new Set(summary.excerpted);
  const listedOnly = summary.paths.filter((path) => !read.has(path));
  return `<summary>Evidence read · ${esc(summary.trigger)} · ${esc(new Date(summary.generatedAt).toLocaleString())}</summary>`
    + `<p class="project-help" data-evidence-scope>Depth ${esc(summary.selection.preset ?? "custom")} · scope: ${esc(scope)} · budgets: ${summary.selection.evidenceChars} chars, ${summary.selection.files} files, ${summary.selection.fileChars} chars per file</p>`
    + `<dl class="project-evidence-facts">`
    + `<dt>Inventory</dt><dd>${summary.inventory.total} candidates (${esc(counts(summary.inventory.byKind))}); ${summary.inventory.withSymbols} with declared symbols</dd>`
    + `<dt>Excerpts</dt><dd>${summary.excerpts.total} files (${esc(counts(summary.excerpts.byKind))}); ${summary.excerpts.truncated} truncated</dd>`
    + `<dt>No excerpt</dt><dd>${summary.omitted.files} candidates listed by path only</dd>`
    + `</dl>`
    + (summary.coverage.length ? `<ul class="project-diagram-coverage">${summary.coverage.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` : "")
    + `<h4>Read in full or in part (${summary.excerpted.length})</h4><div class="project-evidence-paths" data-evidence-excerpted>${paths(summary.excerpted, 120)}</div>`
    + `<h4>Listed without an excerpt (${listedOnly.length})</h4><div class="project-evidence-paths" data-evidence-listed>${paths(listedOnly, 200)}</div>`;
}

const KIND_LABELS: Record<ProjectDiagramKind, string> = {
  architecture: "Architecture",
  workflow: "Workflow",
  sequence: "Sequence",
  data_flow: "Data flow",
  lifecycle: "Lifecycle"
};

export const PROJECT_DIAGRAM_KIND_LABELS = KIND_LABELS;

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function diagramOption(diagram: ProjectDiagramSummary, selectedId: string | undefined): string {
  return `<option value="${escapeAttribute(diagram.id)}" data-diagram-version="${diagram.version}"${diagram.id === selectedId ? " selected" : ""}>`
    + `${escapeHtml(diagram.title)} · ${escapeHtml(KIND_LABELS[diagram.kind])} · v${diagram.version}</option>`;
}

function renderToolbar(input: ArchitectureViewInput): string {
  const selected = input.selected;
  const engineNote = input.engine && !input.engine.available
    ? `<p class="project-diagram-engine-error" role="status">Archify runtime unavailable: ${escapeHtml(input.engine.reason ?? "unknown reason")}</p>`
    : "";
  return `<section class="project-diagram-toolbar" data-diagram-controls>
    <label class="project-diagram-select"><span>Diagram</span><select data-diagram-select aria-label="Select diagram"${input.diagrams.length ? "" : " disabled"}>`
    + (input.diagrams.length ? input.diagrams.map((diagram) => diagramOption(diagram, selected?.id)).join("") : `<option value="">No diagram generated yet</option>`)
    + `</select></label>
    <button type="button" data-diagram-action="refresh"${selected ? "" : " disabled"}>Refresh</button>
    <label class="project-diagram-export"><span>Export</span><select data-diagram-export-format aria-label="Export format"><option value="html">HTML</option><option value="svg">SVG</option></select></label>
    <button type="button" data-diagram-action="export"${selected ? "" : " disabled"}>Export</button>
    <button type="button" data-diagram-action="fullscreen"${selected ? "" : " disabled"}>Fullscreen</button>
    ${engineNote}
  </section>`;
}

function renderGenerateForm(input: ArchitectureViewInput): string {
  const kinds = (Object.keys(KIND_LABELS) as ProjectDiagramKind[]).map((kind) => `<option value="${kind}">${escapeHtml(KIND_LABELS[kind])}</option>`).join("");
  return `<section class="project-diagram-generate" data-diagram-generate>
    <h3>Generate or update a diagram on demand</h3>
    <p class="project-help">Reuses the project AI configuration and reads only bounded README, documentation, manifest and necessary source text. Generating a new diagram neither re-initializes the project nor overwrites other diagrams.</p>
    <label><span>Requirement</span><textarea data-diagram-requirement rows="3" placeholder="Describe the business or technical problem to express, for example the order flow from submission to completion, including failure branches."></textarea></label>
    <div class="project-diagram-generate-row">
      <label><span>Type</span><select data-diagram-kind><option value="">Automatic</option>${kinds}</select></label>
      <button type="button" data-diagram-generate-new${input.generating ? " disabled" : ""}>Generate diagram</button>
      <button type="button" data-diagram-generate-update${input.selected && !input.generating ? "" : " disabled"}>Update current diagram</button>
      <span class="project-diagram-generating" data-diagram-generating${input.generating ? "" : " hidden"}>Generating…</span>
    </div>
    <p class="project-diagram-generate-error" data-diagram-generate-error${input.generationError ? "" : " hidden"}>${input.generationError ? escapeHtml(input.generationError) : ""}</p>
  </section>`;
}

function renderDetails(input: ArchitectureViewInput): string {
  const selected = input.selected;
  const render = input.render;
  const issues = render?.issues ?? [];
  const issueRows = issues.map((issue) => `<li data-diagram-issue="${escapeAttribute(issue.code)}"><code>${escapeHtml(issue.severity)}</code> ${escapeHtml(issue.message)}</li>`).join("");
  const coverage = input.coverage ?? [];
  const coverageRows = coverage.map((note) => `<li data-coverage-note="1">${escapeHtml(note)}</li>`).join("");
  const versionLine = render?.displayedVersion !== undefined
    ? `v${render.displayedVersion}${render.usedLastGood ? ` (last successful result; requested v${render.requestedVersion ?? "?"} failed to render)` : ""}`
    : selected ? `v${selected.version}` : "—";
  return `<details class="project-diagram-details"${render?.error ? " open" : ""}>
    <summary>Validation, version and evidence coverage</summary>
    <dl>
      <dt>Displayed version</dt><dd data-diagram-displayed-version>${escapeHtml(versionLine)}</dd>
      <dt>Diagram ID</dt><dd><code>${escapeHtml(render?.diagramId ?? selected?.id ?? "—")}</code></dd>
      <dt>Validation</dt><dd data-diagram-validation-status>${escapeHtml(render?.status ?? "Not rendered yet")}${issues.length ? ` · ${issues.length} ${issues.length === 1 ? "issue" : "issues"}` : ""}</dd>
      <dt>Rendered at</dt><dd>${render?.updatedAt ? escapeHtml(new Date(render.updatedAt).toLocaleString()) : "—"}</dd>
      <dt>Engine</dt><dd>${input.engine ? `Archify ${escapeHtml(input.engine.version)}${input.engine.available ? "" : " (unavailable)"}` : "—"}</dd>
    </dl>
    ${render?.error ? `<p class="project-diagram-render-error" role="status">${escapeHtml(render.error)}</p>` : ""}
    ${issueRows ? `<ul class="project-diagram-issues">${issueRows}</ul>` : ""}
    ${coverageRows ? `<h4>Evidence coverage</h4><ul class="project-diagram-coverage">${coverageRows}</ul>` : ""}
  </details>`;
}

function renderEmpty(input: ArchitectureViewInput): string {
  if (!input.diagrams.length) {
    return `<div class="project-diagram-empty" data-diagram-empty role="status"><strong>No diagram generated yet</strong>`
      + `<p>${input.knowledgeUninitialized ? "Project knowledge is not initialized yet. Initialize it on the Overview page, or describe a requirement below to generate the first diagram." : "Describe a requirement below to generate an architecture, workflow, sequence, data-flow or lifecycle diagram."}</p></div>`;
  }
  if (input.engine && !input.engine.available) {
    return `<div class="project-diagram-empty" data-diagram-empty role="status"><strong>Archify runtime unavailable</strong><p>${escapeHtml(input.engine.reason ?? "")}</p></div>`;
  }
  return "";
}

/**
 * The node panel stays in the page so choosing a card does not yank the reader into a file. It
 * floats over the stage while the diagram is focused.
 */
function renderNodePanel(): string {
  return `<section class="project-diagram-node" data-diagram-node hidden>`
    + `<div class="project-diagram-node-head"><strong data-diagram-node-label></strong>`
    + `<button type="button" data-diagram-action="close-node">Close</button></div>`
    + `<p class="project-diagram-node-description" data-diagram-node-description hidden></p>`
    + `<dl class="project-diagram-node-meta" data-diagram-node-meta hidden></dl>`
    + `<div class="project-diagram-node-evidence" data-diagram-node-evidence></div>`
    + `</section>`;
}

/** Renders the Diagrams page: diagram selection, native Archify viewer and generation controls. */
export function renderArchitectureView(input: ArchitectureViewInput): string {
  const selected = input.selected;
  const knowledgeNote = input.knowledgeUninitialized
    ? `<p class="project-diagram-knowledge-note" role="status">Project knowledge is not initialized; saved diagrams remain viewable and exportable.</p>`
    : "";
  const session = input.render?.diagramId ?? selected?.id ?? "none";
  return `<div class="architecture-view project-diagram-view" data-architecture-view="2" data-diagram-session="${escapeAttribute(session)}">`
    + knowledgeNote
    + renderToolbar(input)
    + `<div class="project-diagram-stage" data-diagram-stage>`
    // The viewer runs in a scripts-only sandbox, so it needs the fullscreen permission explicitly.
    + `<iframe class="project-diagram-frame" data-diagram-frame sandbox="allow-scripts" allow="fullscreen" allowfullscreen title="Archify diagram" hidden></iframe>`
    + `<button type="button" class="project-diagram-exit" data-diagram-action="exit-fullscreen" hidden>Exit fullscreen</button>`
    + `<div class="project-diagram-loading" data-diagram-loading${selected ? "" : " hidden"}>Rendering Archify diagram…</div>`
    + renderEmpty(input)
    + `</div>`
    + renderNodePanel()
    + `<details class="project-diagram-evidence" data-diagram-evidence${input.evidence ? "" : " hidden"}>${evidenceSummaryHtml(input.evidence)}</details>`
    + renderDetails(input)
    + renderGenerateForm(input)
    + `<section class="architecture-relation-section project-diagram-inventory"><h3>Saved diagrams (${input.diagrams.length})</h3>`
    + (input.diagrams.length
      ? `<ul>${input.diagrams.map((diagram) => `<li data-diagram-inventory-id="${escapeAttribute(diagram.id)}"><strong>${escapeHtml(diagram.title)}</strong> · ${escapeHtml(KIND_LABELS[diagram.kind])} · v${diagram.version} · ${escapeHtml(diagram.review ?? "draft")}</li>`).join("")}</ul>`
      : `<p class="architecture-empty">No saved diagrams yet.</p>`)
    + `</section>`
    + renderRules(input)
    + renderDecisions(input.decisions ?? [])
    + `</div>`;
}

function renderRules(input: ArchitectureViewInput): string {
  const rules = input.rules ?? [];
  const violations = input.violations ?? [];
  const baseline = input.baselineViolations ?? [];
  const note = input.rulesNote;
  if (!rules.length && !violations.length && !baseline.length && !note) return "";
  const ruleRows = rules.map((rule) => `<li class="architecture-rule"><code>${escapeHtml(rule.id)}</code> `
    + `${escapeHtml(rule.type)} ${escapeHtml(rule.from)}${rule.to ? ` &rarr; ${escapeHtml(rule.to)}` : ""}`
    + `${rule.reason ? ` &mdash; ${escapeHtml(rule.reason)}` : ""}</li>`).join("");
  // Without a baseline there is nothing to compare against, so the current violations are reported
  // as what they are instead of being labelled "new".
  const heading = baseline.length ? `New violations (${violations.length})` : `Violations (${violations.length})`;
  return `<section class="architecture-rules"><h3>Rules</h3>${ruleRows ? `<ul>${ruleRows}</ul>` : ""}`
    + (note ? `<p class="architecture-empty">${escapeHtml(note)}</p>` : "")
    + `<h4>${heading}</h4>${renderViolations(violations)}`
    + (baseline.length ? `<h4>Existing baseline violations (${baseline.length})</h4>${renderViolations(baseline)}` : "")
    + `</section>`;
}

function renderViolations(violations: readonly ArchitectureViolation[]): string {
  if (!violations.length) return `<p class="architecture-empty">None.</p>`;
  return `<ul class="architecture-violations">${violations.map((violation) =>
    `<li><code>${escapeHtml(violation.ruleId)}</code> ${escapeHtml(violation.nodeIds.join(" -> "))}: ${escapeHtml(violation.reason)}</li>`).join("")}</ul>`;
}

function renderDecisions(decisions: readonly ProjectArchitectureDecision[]): string {
  if (!decisions.length) return "";
  return `<section class="architecture-decisions"><h3>Design decisions</h3>${decisions.map((decision) =>
    `<article class="architecture-decision"><h4>${escapeHtml(decision.title)}</h4><p>${escapeHtml(decision.detail)}</p></article>`).join("")}</section>`;
}

function parentBridgeScript(): string {
  return `(function(){
    var root = document.querySelector('[data-architecture-view="2"]');
    if (!root) return;
    var api = window.__dextApi || (window.__dextApi = acquireVsCodeApi());
    // The trust rules are the tested functions from the viewer module, injected as source so the
    // shipped bridge cannot drift from what the unit tests cover.
    var isTrustedViewerMessage = ${isTrustedViewerMessage.toString()};
    var isTrustedHostMessage = ${isTrustedHostMessage.toString()};
    var evidenceSummaryHtml = ${evidenceSummaryHtml.toString()};
    var scriptNonce = document.currentScript && document.currentScript.nonce ? document.currentScript.nonce : "";
    var frame = root.querySelector('[data-diagram-frame]');
    var stage = root.querySelector('[data-diagram-stage]');
    var loading = root.querySelector('[data-diagram-loading]');
    var session = "s" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    var selectedId = root.querySelector('[data-diagram-select]') ? root.querySelector('[data-diagram-select]').value : "";
    var displayedVersion = null;
    var nodeMap = null;
    var pendingExport = null;
    var nodeDetails = [];
    var nodeById = {};
    var activeNodeId = "";
    /**
     * The webview host refuses the browser Fullscreen API, so the button first tries the native
     * path and otherwise fills the whole webview with the stage. Either way the same button and
     * Escape leave the mode again.
     */
    function diagramFocusOn() { return document.body.classList.contains("diagram-focus"); }
    function syncFullscreenControls() {
      var active = diagramFocusOn() || document.fullscreenElement === stage;
      var button = root.querySelector("[data-diagram-action=fullscreen]");
      if (button) button.textContent = active ? "Exit fullscreen" : "Fullscreen";
      var exit = root.querySelector("[data-diagram-action=exit-fullscreen]");
      if (exit) exit.hidden = !active;
      sendToFrame({ type: "dext-diagram-command", command: "fullscreen", active: active });
    }
    function setDiagramFocus(on) {
      document.body.classList.toggle("diagram-focus", Boolean(on));
      syncFullscreenControls();
    }
    function exitDiagramFullscreen() {
      if (document.fullscreenElement === stage) { if (document.exitFullscreen) document.exitFullscreen(); return; }
      if (diagramFocusOn()) setDiagramFocus(false);
    }
    function toggleDiagramFullscreen() {
      if (!stage) return;
      if (document.fullscreenElement === stage || diagramFocusOn()) { exitDiagramFullscreen(); return; }
      try {
        var request = stage.requestFullscreen ? stage.requestFullscreen() : null;
        if (request && typeof request.then === "function") { request.then(syncFullscreenControls, function () { setDiagramFocus(true); }); return; }
      } catch (error) {
        // A rejected Fullscreen API is expected inside VS Code; the in-view focus mode replaces it.
      }
      setDiagramFocus(true);
    }
    function hideNodeDetails() {
      var panel = root.querySelector("[data-diagram-node]");
      if (panel) panel.hidden = true;
      activeNodeId = "";
    }
    function nodeText(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text;
      return node;
    }
    function showNodeDetails(nodeId) {
      var panel = root.querySelector("[data-diagram-node]");
      if (!panel) return;
      var detail = nodeById[nodeId];
      if (!detail) { hideNodeDetails(); return; }
      activeNodeId = nodeId;
      var label = panel.querySelector("[data-diagram-node-label]");
      if (label) label.textContent = detail.label || nodeId;
      var description = panel.querySelector("[data-diagram-node-description]");
      if (description) { description.textContent = detail.description || ""; description.hidden = !detail.description; }
      var meta = panel.querySelector("[data-diagram-node-meta]");
      if (meta) {
        meta.textContent = "";
        var rows = [];
        if (detail.role) rows.push(["Role", String(detail.role)]);
        if (detail.semanticIds && detail.semanticIds.length) rows.push(["Semantics", detail.semanticIds.join(", ")]);
        if (typeof detail.confidence === "number") rows.push(["Confidence", Math.round(detail.confidence * 100) + "%"]);
        if (detail.review) rows.push(["Review", String(detail.review)]);
        if (detail.freshness) rows.push(["Freshness", String(detail.freshness)]);
        for (var index = 0; index < rows.length; index += 1) {
          meta.appendChild(nodeText("dt", "", rows[index][0]));
          meta.appendChild(nodeText("dd", "", rows[index][1]));
        }
        meta.hidden = rows.length === 0;
      }
      var evidence = panel.querySelector("[data-diagram-node-evidence]");
      if (evidence) {
        evidence.textContent = "";
        var entries = detail.evidence || [];
        if (!entries.length) evidence.appendChild(nodeText("p", "project-help", "This node declares no evidence file."));
        for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
          var entry = entries[entryIndex] || {};
          var button = document.createElement("button");
          button.type = "button";
          button.setAttribute("data-diagram-evidence-path", entry.path || "");
          if (entry.line) button.setAttribute("data-diagram-evidence-line", String(entry.line));
          button.textContent = "Open " + (entry.path || "") + (entry.line ? ":" + entry.line : "") + (entry.note ? " — " + entry.note : "");
          evidence.appendChild(button);
        }
      }
      panel.hidden = false;
      // A tall diagram can push the panel below the fold, so bring it into view without moving the
      // reader away from the card they clicked. Focus mode floats the panel instead.
      if (!diagramFocusOn() && panel.scrollIntoView) {
        try { panel.scrollIntoView({ block: "nearest" }); } catch (error) { panel.scrollIntoView(false); }
      }
    }
    function selectedKind() {
      var option = root.querySelector('[data-diagram-select] option:checked');
      var id = option ? option.value : "";
      var inventory = id ? root.querySelector('[data-diagram-inventory-id="' + id.replace(/"/g, '\\\\"') + '"]') : null;
      return inventory ? "selected" : "";
    }
    function post(message) { api.postMessage(message); }
    function sendToFrame(message) {
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage(Object.assign({ __dext: session }, message), "*");
    }
    function currentTheme() {
      var body = document.body;
      if (body && (body.classList.contains("vscode-light") || body.classList.contains("vscode-high-contrast-light"))) return "light";
      try { if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light"; } catch (error) {}
      return "dark";
    }
    function buildSrcdoc(html) {
      var nonce = scriptNonce;
      var bridge = ${JSON.stringify(archifyViewerBridgeScript("__SESSION__", "dark"))}.replace("__SESSION__", session);
      bridge = bridge.replace(/var desired = "[a-z]+";/, "var desired = " + JSON.stringify(currentTheme()) + ";");
      bridge = bridge.replace(/var desiredTheme = "[a-z]+";/, "var desiredTheme = " + JSON.stringify(currentTheme()) + ";");
      var scriptOpen = "<script nonce=" + JSON.stringify(nonce) + ">";
      var injected = html.replace("<head>", "<head>" + scriptOpen + bridge + "<\\/script>");
      return injected.replace(/<script(?![^>]*\\bnonce=)/g, function () { return "<script nonce=" + JSON.stringify(nonce); });
    }
    function setStatus(text, kind) {
      var status = root.querySelector("[data-diagram-render-status]");
      if (!status) {
        status = document.createElement("p");
        status.setAttribute("data-diagram-render-status", "1");
        status.setAttribute("role", "status");
        root.querySelector("[data-diagram-stage]").appendChild(status);
      }
      status.textContent = text || "";
      status.hidden = !text;
      status.className = "project-diagram-render-status" + (kind ? " " + kind : "");
    }
    function setDetails(message) {
      var versionNode = root.querySelector("[data-diagram-displayed-version]");
      if (versionNode && message.displayedVersion !== undefined) {
        versionNode.textContent = "v" + message.displayedVersion + (message.usedLastGood ? " (last successful result; requested v" + message.requestedVersion + " failed to render)" : "");
      }
      var statusNode = root.querySelector("[data-diagram-validation-status]");
      if (statusNode) {
        var issues = message.receipt && message.receipt.issues ? message.receipt.issues.length : 0;
        statusNode.textContent = (message.receipt && message.receipt.status ? message.receipt.status : "unknown") + (issues ? " · " + issues + (issues === 1 ? " issue" : " issues") : "");
      }
      var list = root.querySelector(".project-diagram-issues");
      var issues = message.receipt && message.receipt.issues ? message.receipt.issues : [];
      if (issues.length) {
        if (!list) { list = document.createElement("ul"); list.className = "project-diagram-issues"; root.querySelector(".project-diagram-details").appendChild(list); }
        list.innerHTML = issues.slice(0, 40).map(function (issue) {
          return "<li><code>" + String(issue.severity || "").replace(/[&<>"']/g, "") + "</code> " + String(issue.message || "").replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }) + "</li>";
        }).join("");
      } else if (list) { list.remove(); }
      var error = root.querySelector(".project-diagram-render-error");
      if (message.error) {
        if (!error) { error = document.createElement("p"); error.className = "project-diagram-render-error"; error.setAttribute("role", "status"); root.querySelector(".project-diagram-details").appendChild(error); }
        error.textContent = message.error;
      } else if (error) { error.remove(); }
    }
    function showDiagram(message) {
      if (!frame) return;
      selectedId = message.diagramId;
      displayedVersion = message.displayedVersion;
      var select = root.querySelector("[data-diagram-select]");
      if (select) for (var index = 0; index < select.options.length; index += 1) if (select.options[index].value === selectedId) select.selectedIndex = index;
      nodeMap = message.mapping ? message.mapping.reverseIds : null;
      nodeDetails = Array.isArray(message.nodes) ? message.nodes : [];
      nodeById = {};
      for (var nodeIndex = 0; nodeIndex < nodeDetails.length; nodeIndex += 1) {
        if (nodeDetails[nodeIndex] && nodeDetails[nodeIndex].id) nodeById[nodeDetails[nodeIndex].id] = nodeDetails[nodeIndex];
      }
      hideNodeDetails();
      root.querySelector("[data-diagram-empty]") && root.querySelector("[data-diagram-empty]").setAttribute("hidden", "");
      if (loading) loading.hidden = false;
      try { frame.srcdoc = buildSrcdoc(String(message.html || "")); } catch (error) { setStatus("Unable to load diagram: " + String(error && error.message || error), "error"); }
      frame.hidden = false;
      setDetails(message);
      setStatus(message.usedLastGood ? "Showing the last successful result for the same diagram (v" + message.displayedVersion + ")." : "", message.usedLastGood ? "warning" : "");
    }
    frame && frame.addEventListener("load", function () {
      if (loading) loading.hidden = true;
      sendToFrame({ type: "dext-diagram-command", command: "map", nodes: nodeMap || {} });
      sendToFrame({ type: "dext-diagram-command", command: "theme", theme: currentTheme() });
    });
    window.addEventListener("message", function (event) {
      var message = event && event.data;
      if (!message || typeof message !== "object") return;
      var frameWindow = frame && frame.contentWindow;
      if (event.source === frameWindow) {
        // Only the sandboxed viewer may send bridge traffic, and only for this session.
        if (!isTrustedViewerMessage(event.source, frameWindow, message, session)) return;
      } else if (!isTrustedHostMessage(event.source, frameWindow, message)) {
        // Host messages come from the VS Code webview runtime (source is not the iframe).
        return;
      }
      if (message.type === "dext-diagram-export" && message.format === "svg" && typeof message.content === "string") {
        var target = pendingExport || { diagramId: selectedId, version: displayedVersion };
        pendingExport = null;
        post({ type: "projectDiagramExport", diagramId: target.diagramId, version: target.version, format: "svg", content: message.content });
        return;
      }
      if (message.type === "dext-diagram-node" && typeof message.nodeId === "string") {
        // Selecting a card reports the node in place; opening its evidence stays an explicit choice.
        showNodeDetails(message.nodeId);
        return;
      }
      if (message.type === "dext-diagram-ready") {
        sendToFrame({ type: "dext-diagram-command", command: "map", nodes: nodeMap || {} });
        syncFullscreenControls();
        return;
      }
      if (typeof message.type !== "string") return;
      if (message.type === "projectEvidenceSummary") {
        var evidence = root.querySelector("[data-diagram-evidence]");
        if (evidence) {
          evidence.innerHTML = evidenceSummaryHtml(message.summary);
          evidence.hidden = false;
        }
        return;
      }
      if (message.type === "projectDiagramRendered") { showDiagram(message); return; }
      if (message.type === "projectDiagramRenderFailed") {
        if (loading) loading.hidden = true;
        setStatus(message.error || "Archify rendering failed.", "error");
        return;
      }
      if (message.type === "projectDiagramGenerating") {
        var busy = Boolean(message.active);
        root.querySelectorAll("[data-diagram-generate-new], [data-diagram-generate-update]").forEach(function (button) { button.disabled = busy; });
        var indicator = root.querySelector("[data-diagram-generating]");
        if (indicator) indicator.hidden = !busy;
        if (busy) setStatus("Generating diagram…", "");
        return;
      }
      if (message.type === "projectDiagramGenerated") {
        var diagram = message.diagram || {};
        var select = root.querySelector("[data-diagram-select]");
        if (select && diagram.id) {
          var existing = null;
          for (var index = 0; index < select.options.length; index += 1) if (select.options[index].value === diagram.id) existing = select.options[index];
          if (!existing) { existing = document.createElement("option"); select.appendChild(existing); }
          existing.value = diagram.id;
          existing.textContent = (diagram.title || diagram.id) + " · v" + diagram.version;
          existing.setAttribute("data-diagram-version", String(diagram.version));
          select.value = diagram.id;
          select.disabled = false;
        }
        setStatus(message.updated ? "Updated diagram " + (diagram.title || diagram.id) + " v" + diagram.version + "." : "Generated diagram " + (diagram.title || diagram.id) + " v" + diagram.version + ".", "");
        return;
      }
      if (message.type === "projectDiagramGenerateFailed") {
        var errorNode = root.querySelector("[data-diagram-generate-error]");
        if (errorNode) { errorNode.hidden = false; errorNode.textContent = message.error || "Generation failed."; }
        setStatus(message.error || "Generation failed.", "error");
        return;
      }
      if (message.type === "projectDiagramExported") {
        setStatus(message.cancelled ? "Export cancelled." : "Exported " + String(message.format || "").toUpperCase() + (message.fileName ? ": " + message.fileName : "") + ".", "");
        return;
      }
      if (message.type === "projectDiagramExportFailed") { setStatus(message.error || "Export failed.", "error"); return; }
    });
    try { window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () { sendToFrame({ type: "dext-diagram-command", command: "theme", theme: currentTheme() }); }); } catch (error) {}
    root.addEventListener("change", function (event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (target.matches("[data-diagram-select]")) {
        var option = target.options[target.selectedIndex];
        selectedId = target.value;
        displayedVersion = option ? Number(option.getAttribute("data-diagram-version")) : undefined;
        hideNodeDetails();
        root.querySelector("[data-diagram-empty]") && root.querySelector("[data-diagram-empty]").setAttribute("hidden", "");
        if (loading) loading.hidden = false;
        setStatus("", "");
        post({ type: "projectDiagramRender", diagramId: target.value, version: displayedVersion });
      }
    });
    root.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target.closest("button, [data-diagram-action]") : null;
      if (!target) return;
      var summaryPath = target.getAttribute("data-evidence-path");
      if (summaryPath) {
        post({ type: "projectEvidenceOpen", path: summaryPath });
        return;
      }
      var evidencePath = target.getAttribute("data-diagram-evidence-path");
      if (evidencePath) {
        var evidenceLine = Number(target.getAttribute("data-diagram-evidence-line") || 0);
        var evidencePayload = { type: "projectDiagramEvidence", diagramId: selectedId, nodeId: activeNodeId, path: evidencePath };
        if (evidenceLine > 0) evidencePayload.line = evidenceLine;
        post(evidencePayload);
        return;
      }
      var action = target.getAttribute("data-diagram-action");
      if (target.hasAttribute("data-diagram-generate-new") || target.hasAttribute("data-diagram-generate-update")) {
        var requirement = (root.querySelector("[data-diagram-requirement]") || {}).value || "";
        var kindSelect = root.querySelector("[data-diagram-kind]");
        var update = target.hasAttribute("data-diagram-generate-update");
        var payload = { type: "projectDiagramGenerate", requirement: requirement };
        if (kindSelect && kindSelect.value) payload.kind = kindSelect.value;
        if (update) { payload.diagramId = selectedId; }
        var errorNode = root.querySelector("[data-diagram-generate-error]");
        if (errorNode) errorNode.hidden = true;
        setStatus(update ? "Updating the current diagram…" : "Generating a new diagram…", "");
        post(payload);
        return;
      }
      if (action === "refresh") {
        if (loading) loading.hidden = false;
        post({ type: "projectDiagramRender", diagramId: selectedId, version: displayedVersion, refresh: true });
        return;
      }
      if (action === "export") {
        var formatNode = root.querySelector("[data-diagram-export-format]");
        var format = formatNode ? formatNode.value : "html";
        if (format === "svg") { pendingExport = { diagramId: selectedId, version: displayedVersion }; sendToFrame({ type: "dext-diagram-command", command: "export-svg", requestId: "svg-" + Date.now() }); }
        else post({ type: "projectDiagramExport", diagramId: selectedId, version: displayedVersion, format: "html" });
        return;
      }
      if (action === "fullscreen") { toggleDiagramFullscreen(); return; }
      if (action === "exit-fullscreen") { exitDiagramFullscreen(); return; }
      if (action === "close-node") { hideNodeDetails(); return; }
    });
    var select = root.querySelector("[data-diagram-select]");
    if (select && select.value) {
      var option = select.options[select.selectedIndex];
      selectedId = select.value;
      displayedVersion = option ? Number(option.getAttribute("data-diagram-version")) : undefined;
      post({ type: "projectDiagramRender", diagramId: selectedId, version: displayedVersion });
    }
    document.addEventListener("fullscreenchange", syncFullscreenControls);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && diagramFocusOn()) setDiagramFocus(false);
    });
    syncFullscreenControls();
    window.addEventListener("pagehide", function () { post({ type: "projectDiagramCancel" }); });
  })();`;
}

export function projectDiagramScript(): string {
  return `<script>${parentBridgeScript()}</script>`;
}
