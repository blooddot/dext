import type { KnowledgeSuggestion } from "../core/projectKnowledgeReview.js";
import type { ProjectObject } from "../core/projectKnowledge.js";
import type { EditorTabState } from "../editorTabState.js";
import type { ProjectInitializationState } from "../projectService.js";
import { renderArchitectureView, projectDiagramScript, type ArchitectureViewInput } from "./projectArchitectureView.js";
import type { ProjectEvidenceSettings } from "../core/projectEvidenceSettings.js";
import type { ProjectWorkspaceSettings } from "../core/projectSettings.js";
import { renderProjectSettings, projectSettingsScript } from "./projectSettingsView.js";

export type ProjectPanelPage = "overview" | "knowledge" | "architecture";

export const PROJECT_PANEL_PAGES: readonly ProjectPanelPage[] = ["overview", "knowledge", "architecture"];

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export interface ProjectOverviewData {
  name: string;
  root: string;
  objects: number;
  accepted: number;
  drafts: number;
  needsVerification: number;
  initialization: ProjectInitializationState;
  evidenceSettings?: ProjectEvidenceSettings;
  evidenceSettingsVersion?: number;
  workspaceSettings?: ProjectWorkspaceSettings;
  workspaceSettingsVersion?: number;
  /** Available Agent CLI profiles and the project-specific selection. */
  aiCli?: readonly { id: string; label: string; models?: readonly {
    id: string;
    label: string;
    /** Optional ACP metadata mirrored from the Input model picker. */
    group?: string;
    reasoningEfforts?: readonly string[];
    speedTiers?: readonly string[];
    serviceTiers?: readonly string[];
  }[] }[];
  selectedAiCli?: string;
  selectedAiModel?: string;
  selectedAiReasoning?: string;
  selectedAiSpeed?: string;
  /** Removed scanner profile still present in `.dext/project.json`; it never affects evidence. */
  legacyScanRoots?: readonly string[];
}

export interface ProjectPanelData {
  overview: ProjectOverviewData;
  /** Long-term objects only. Conversation runs never reach this view. */
  objects: readonly ProjectObject[];
  drafts?: readonly KnowledgeSuggestion[];
  architecture: ArchitectureViewInput;
  knowledge?: {
    brief?: string;
    contexts?: readonly { id: string; name: string; description?: string; evidence?: readonly string[] }[];
    terms?: readonly { id: string; canonical: string; aliases?: readonly string[]; definition?: string }[];
    flows?: readonly { id: string; name: string; steps: readonly string[] }[];
    evidence?: readonly { id: string; path: string; line?: number; note?: string }[];
  };
}

const PAGE_LABELS: Record<ProjectPanelPage, string> = { overview: "Overview", knowledge: "Knowledge", architecture: "Diagrams" };

function renderProjectModelControl(models: readonly NonNullable<NonNullable<ProjectOverviewData["aiCli"]>[number]["models"]>[number][], selected: string | undefined, reasoning: string | undefined, speed: string | undefined, disabled: boolean): string {
  const selectedModel = models.find((model) => model.id === selected);
  const modelItems = [{ id: "", label: "Use CLI default" }, ...models.map((model) => ({ id: model.id, label: model.label, group: model.group ?? "", reasoningEfforts: model.reasoningEfforts ?? [], speedTiers: model.speedTiers ?? [] }))];
  const reasoningItems = (selectedModel?.reasoningEfforts ?? []).map((id) => ({ id, label: id }));
  const speedItems = (selectedModel?.speedTiers ?? []).map((id) => ({ id, label: id }));
  const legacyDetails = [reasoningItems.length ? `Reasoning: ${reasoningItems.map((item) => item.label).join(" / ")}` : "", speedItems.length ? `Speed: ${speedItems.map((item) => item.label).join(" / ")}` : ""].filter(Boolean).join(" · ");
  const capabilitySummary = [reasoning ? `Reasoning: ${reasoning}` : reasoningItems.length ? `Reasoning: ${reasoningItems.map((item) => item.label).join(" / ")}` : "", speed ? `Speed: ${speed}` : speedItems.length ? `Speed: ${speedItems.map((item) => item.label).join(" / ")}` : ""].filter(Boolean).join(" · ");
  const category = (id: string, label: string, value: string, items: readonly { id: string; label: string }[]) => `<button type="button" class="project-model-category composer-menu-option composer-menu-category" data-project-model-category="${id}" data-selected="${escapeHtml(id === "model" ? selected ?? "" : id === "reasoning" ? reasoning ?? "" : speed ?? "")}" data-items="${escapeHtml(JSON.stringify(items))}"${disabled || !items.length ? " disabled" : ""}><span>${label}</span><span class="project-model-category-value" data-project-model-value="${id}">${escapeHtml(value)}</span><i class="codicon codicon-chevron-right" aria-hidden="true"></i></button>`;
  return `<label class="project-ai-model">Model for Project initialization <div class="project-ai-model-control${disabled ? " is-disabled" : ""}"><button type="button" class="project-model-trigger" data-project-ai-model data-project-model-trigger aria-expanded="false"${disabled ? " disabled" : ""} value="${escapeHtml(selected ?? "")}"><span>Model</span><strong data-project-model-value="model">${escapeHtml(selectedModel ? `${selectedModel.label}${selectedModel.group ? ` · ${selectedModel.group}` : ""}` : "Use CLI default")}</strong><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>${capabilitySummary ? `<small class="project-model-capabilities" data-project-model-capabilities>${escapeHtml(capabilitySummary)}</small>` : ""}<input type="hidden" value="${escapeHtml(selected ?? "")}"${selected ? " selected" : ""}><small class="project-ai-model-details" data-project-ai-model-details hidden>${escapeHtml(legacyDetails)}</small><div class="project-model-popover composer-model-popover" data-project-model-menu hidden>${category("model", "Model", selectedModel ? `${selectedModel.label}${selectedModel.group ? ` · ${selectedModel.group}` : ""}` : "Use CLI default", modelItems)}${category("reasoning", "Reasoning", reasoning ?? "CLI setting", reasoningItems)}${category("speed", "Speed", speed ?? "CLI setting", speedItems)}<div class="project-model-submenu composer-model-submenu" data-project-model-submenu hidden></div></div></div></label>`;
}

function renderProjectInitializationSettings(overview: ProjectOverviewData): string {
  const initialization = overview.initialization;
  if (!overview.aiCli?.length) return "";
  return `<label class="project-ai-cli">AI CLI for Project initialization <select data-project-ai-cli${initialization.status === "running" ? " disabled" : ""}><option value=""${overview.selectedAiCli ? "" : " selected"}>Use current Input selection</option>${overview.aiCli.map((cli) => `<option value="${escapeHtml(cli.id)}"${cli.id === overview.selectedAiCli ? " selected" : ""} data-models="${escapeHtml(JSON.stringify(cli.models ?? []))}">${escapeHtml(cli.label)}</option>`).join("")}</select></label>`
    + (overview.selectedAiCli ? (() => { const cli = overview.aiCli.find((item) => item.id === overview.selectedAiCli); const models = cli?.models ?? []; return models.length ? renderProjectModelControl(models, overview.selectedAiModel, overview.selectedAiReasoning, overview.selectedAiSpeed, initialization.status === "running") : ""; })() : "");
}

export function renderProjectNav(page: ProjectPanelPage): string {
  const items = PROJECT_PANEL_PAGES.map((item) =>
    `<button type="button" role="tab" data-project-page="${item}" aria-selected="${item === page}">${PAGE_LABELS[item]}</button>`).join("");
  return `<nav class="project-nav" role="tablist" aria-label="Project views">${items}</nav>`;
}

const PHASE_LABELS: Record<string, string> = {
  preparing: "Preparing bounded text evidence",
  generating: "AI generation",
  saving: "Validating and saving"
};

function renderInitialization(initialization: ProjectInitializationState): string {
  const phaseLabel = PHASE_LABELS[initialization.phase ?? ""] ?? "Preparing";
  const aiControls = "";
  if (initialization.status === "running") {
    const hasCount = initialization.progress !== undefined && initialization.progressTotal !== undefined && initialization.progressTotal > 0;
    const completed = hasCount ? Math.max(0, Math.min(initialization.progress!, initialization.progressTotal!)) : 0;
    const total = hasCount ? initialization.progressTotal! : 0;
    const progress = hasCount
      ? `<progress class="project-scan-progress-meter" value="${completed}" max="${total}" aria-label="${escapeHtml(phaseLabel)} progress"></progress><strong data-project-progress-count>${completed}/${total}</strong>`
      : `<progress class="project-scan-progress-meter" aria-label="${escapeHtml(phaseLabel)} in progress"></progress>`;
    return `<div class="project-init project-init-running" data-project-init-progress data-project-init-started-at="${initialization.startedAt ?? ""}" role="status" aria-live="polite">`
      + `<div class="project-scan-progress-line"><span class="project-scan-progress-label" data-project-progress-label>Initializing project knowledge · ${escapeHtml(phaseLabel)}${initialization.message ? ` · ${escapeHtml(initialization.message)}` : ""}</span><span class="project-initialization-elapsed" data-project-init-elapsed></span>${progress}</div>`
      + `<pre class="project-initialization-output" data-project-init-output${initialization.output ? "" : " hidden"}>${escapeHtml(initialization.output ?? "")}</pre></div>`;
  }
  if (initialization.status === "completed") {
    const missingDiagram = (initialization.diagramsGenerated ?? 0) === 0;
    return `<div class="project-init project-init-completed" data-project-initialization-state="completed" role="status">`
      + `<p class="project-initialization-result">Project knowledge initialized${initialization.intentGenerated ? " · valid project intent" : ""}${initialization.diagramsGenerated ? ` · ${initialization.diagramsGenerated} diagram${initialization.diagramsGenerated === 1 ? "" : "s"}` : ""}.</p>`
      + (missingDiagram ? `<p class="project-scan-progress project-scan-progress-warning">Knowledge is initialized, but no diagram is saved yet. Use <strong>Diagrams</strong> to generate one for the evidenced semantics.</p>` : "")
      + (initialization.output ? `<details class="project-initialization-log"><summary>Initialization output</summary><pre>${escapeHtml(initialization.output)}</pre></details>` : "")
      + `</div>`;
  }
  const failed = initialization.status === "failed";
  const cancelled = initialization.status === "cancelled";
  const errorDetails = initialization.error || initialization.output
    ? `<details class="project-initialization-error"${failed ? " open" : ""}><summary>${failed ? "Initialization failed" : "Last initialization output"}</summary><pre>${escapeHtml(initialization.error ?? "")}${initialization.output ? `\n\n${escapeHtml(initialization.output)}` : ""}</pre></details>`
    : "";
  const status = failed
    ? `<p class="project-scan-progress project-scan-progress-error" role="status">Initialization failed: ${escapeHtml(initialization.error ?? "Unknown reason.")}</p>`
    : cancelled
      ? `<p class="project-scan-progress" role="status">Initialization cancelled. The previous saved knowledge is unchanged.</p>`
      : `<p class="project-help"><strong>Not initialized.</strong> No valid saved semantic model was found. Initialize project knowledge to let AI read bounded README, documentation, manifest and source text, then validate and save the result.${initialization.diagramsGenerated ? " Saved diagrams remain viewable." : ""}</p>`;
  return `<div class="project-init project-init-uninitialized" data-project-initialization-state="${failed ? "failed" : cancelled ? "cancelled" : "uninitialized"}">`
    + status
    + `<button type="button" class="project-initialize" data-project-initialize>${failed || cancelled ? "Retry initialization" : "Initialize project knowledge"}</button>`
    + errorDetails + aiControls
    + `<div class="project-scan-progress" data-project-init-progress hidden role="status"><div class="project-scan-progress-line"><span class="project-scan-progress-label" data-project-progress-label>Preparing bounded text evidence…</span><progress class="project-scan-progress-meter"></progress></div><pre class="project-initialization-output" data-project-init-output hidden></pre></div>`
    + `</div>`;
}

function renderOverview(overview: ProjectOverviewData): string {
  const initialization = overview.initialization;
  const retiredScan = overview.legacyScanRoots?.length
    ? `<p class="project-scan-progress project-scan-progress-warning" role="status" data-project-legacy-scan>`
      + `The removed <code>scan</code> settings in <code>.dext/project.json</code> still limit Project evidence to: ${overview.legacyScanRoots.map((root) => `<code>${escapeHtml(root)}/**</code>`).join(", ")}. `
      + `These roots are included in Project settings below. Change the reading scope there to manage them.</p>`
    : "";
  return `<section class="project-overview" data-project-section="overview">`
    + `<h2>${escapeHtml(overview.name)}</h2>`
    + `<p class="project-help">Project uses the opened workspace folder as its root. Opening, restoring or switching this page only reads saved project files; source text is read in bounded form when you initialize knowledge or generate a diagram.</p>`
    + retiredScan
    + (overview.workspaceSettings && overview.evidenceSettings
      ? renderProjectSettings(overview.workspaceSettings, overview.evidenceSettings, Math.max(overview.workspaceSettingsVersion ?? 0, overview.evidenceSettingsVersion ?? 0), initialization.status === "running", renderProjectInitializationSettings(overview))
      : renderProjectInitializationSettings(overview))
    + renderInitialization(initialization)
    + `<dl class="project-facts">`
    + `<dt>Workspace</dt><dd>${escapeHtml(overview.root)}</dd>`
    + `<dt>Objects</dt><dd>${overview.objects} (${overview.accepted} accepted, ${overview.drafts} drafts, ${overview.needsVerification} need verification)</dd>`
    + `<dt>Initialization</dt><dd>${escapeHtml(initialization.status)}${initialization.error ? `; ${escapeHtml(initialization.error)}` : ""}</dd>`
    + `</dl></section>`;
}

function renderKnowledge(objects: readonly ProjectObject[], drafts: readonly KnowledgeSuggestion[], knowledge?: ProjectPanelData["knowledge"]): string {
  const rows = objects.map((object) => {
    const names = [object.canonicalName, object.displayName, ...object.aliases].filter(Boolean).join(" / ");
    return `<li class="project-object" data-object-id="${escapeHtml(object.id)}" data-confirmation="${object.confirmation}" data-validity="${object.validity}">`
      + `<strong>${escapeHtml(names)}</strong>`
      + `<span class="object-kind">${escapeHtml(object.kind)}</span>`
      + `<span class="object-state">${escapeHtml(object.confirmation)} &middot; ${escapeHtml(object.validity)} &middot; ${escapeHtml(object.source)}</span>`
      + (object.description ? `<p>${escapeHtml(object.description)}</p>` : "")
      + (object.behavior.length ? `<ul class="object-behavior">${object.behavior.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "")
      + `</li>`;
  }).join("");
  const draftRows = (drafts ?? []).map((draft) => `<li class="project-draft" data-draft-id="${escapeHtml(draft.id)}">`
    + `<strong>${escapeHtml(draft.proposed.canonicalName ?? draft.objectId ?? draft.id)}</strong>`
    + `<span class="draft-kind">${escapeHtml(draft.kind)}</span>`
    + `<p>${escapeHtml(draft.reason)}</p>`
    + `<div class="draft-actions"><button type="button" data-draft-action="accept" data-draft-id="${escapeHtml(draft.id)}">Accept</button>`
    + `<button type="button" data-draft-action="edit" data-draft-id="${escapeHtml(draft.id)}">Edit</button>`
    + `<button type="button" data-draft-action="reject" data-draft-id="${escapeHtml(draft.id)}">Reject</button></div></li>`).join("");
  const semantic = knowledge ? `<section class="project-knowledge-brief"><h3>Project Brief</h3><p>${escapeHtml(knowledge.brief ?? "No AI-generated brief yet.")}</p>`
    + `<h3>Capabilities & contexts</h3>${knowledge.contexts?.length ? `<ul>${knowledge.contexts.map((context) => `<li data-project-semantic-id="${escapeHtml(context.id)}"><strong>${escapeHtml(context.name)}</strong>${context.description ? `<p>${escapeHtml(context.description)}</p>` : ""}${context.evidence?.length ? `<small>Evidence: ${context.evidence.map(escapeHtml).join(", ")}</small>` : ""}</li>`).join("")}</ul>` : `<p class="project-empty">No accepted contexts yet.</p>`}`
    + `<h3>Canonical terms</h3>${knowledge.terms?.length ? `<ul>${knowledge.terms.map((term) => `<li data-project-semantic-id="${escapeHtml(term.id)}"><code>${escapeHtml(term.canonical)}</code>${term.aliases?.length ? ` <span>(${term.aliases.map(escapeHtml).join(", ")})</span>` : ""}${term.definition ? `<p>${escapeHtml(term.definition)}</p>` : ""}</li>`).join("")}</ul>` : `<p class="project-empty">No canonical terms yet.</p>`}`
    + `<h3>Key flows</h3>${knowledge.flows?.length ? `<ul>${knowledge.flows.map((flow) => `<li data-project-semantic-id="${escapeHtml(flow.id)}"><strong>${escapeHtml(flow.name)}</strong><ol>${flow.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></li>`).join("")}</ul>` : `<p class="project-empty">No documented flows yet.</p>`}`
    + `${knowledge.evidence?.length ? `<h3>Evidence</h3><ul>${knowledge.evidence.map((item) => `<li data-project-evidence-id="${escapeHtml(item.id)}"><code>${escapeHtml(item.path)}${item.line ? `:${item.line}` : ""}</code>${item.note ? ` — ${escapeHtml(item.note)}` : ""}</li>`).join("")}</ul>` : ""}`
    + `</section>` : "";
  return `<section class="project-knowledge" data-project-section="knowledge">`
    + semantic
    + `<h2>Knowledge</h2>`
    + (!knowledge ? `<p class="project-help">Project knowledge is not initialized yet. Open <strong>Overview</strong> and choose <em>Initialize project knowledge</em>; initialization never runs automatically. The entries below are long-term objects saved on disk.</p>` : "")
    + `<h3>Objects</h3>${rows ? `<ul class="project-objects">${rows}</ul>` : `<p class="project-empty">No accepted knowledge yet. Development from Input does not require it.</p>`}`
    + `<h3>AI drafts</h3>${draftRows ? `<ul class="project-drafts">${draftRows}</ul>` : `<p class="project-empty">No pending AI drafts.</p>`}`
    + `</section>`;
}

export function projectPanelScript(state?: EditorTabState): string {
  // acquireVsCodeApi may only be called once per webview document, and the diagram
  // bridge script shares this document, so the handle is cached on the window.
  // setState is what a webview serializer receives on reload: without it a restored
  // Project tab has no key and could never render.
  const restore = state ? `api.setState(${JSON.stringify(state)});` : "";
  return "<script>(function(){var api=window.__dextApi||(window.__dextApi=acquireVsCodeApi());" + restore
    + projectSettingsScript()
    + "function closeModelMenu(){var menu=document.querySelector('[data-project-model-menu]');var trigger=document.querySelector('[data-project-model-trigger]');if(menu)menu.hidden=true;if(trigger)trigger.setAttribute('aria-expanded','false');var sub=document.querySelector('[data-project-model-submenu]');if(sub)sub.hidden=true;}"
    + "function positionModelSubmenu(){var sub=document.querySelector('[data-project-model-submenu]'),menu=document.querySelector('[data-project-model-menu]');if(!sub||!menu)return;var r=menu.getBoundingClientRect(),w=Math.min(216,(document.documentElement.clientWidth||window.innerWidth)-24),gap=4;sub.style.width=w+'px';sub.dataset.submenuSide=(window.innerWidth-r.right-gap>=w?'right':r.left-gap>=w?'left':'above');}"
    + "function showModelChoices(category){var sub=document.querySelector('[data-project-model-submenu]');if(!sub)return;var items=[];try{items=JSON.parse(category.getAttribute('data-items')||'[]');}catch(_){}var selected=category.getAttribute('data-selected')||'';var title=category.querySelector('span').textContent;var html='<div class=\"project-model-submenu-heading\">'+title+'</div>';var prior='';items.forEach(function(item){if(item.group&&item.group!==prior){html+='<div class=\"project-model-group-heading\">'+item.group+'</div>';prior=item.group;}html+='<button type=\"button\" class=\"project-model-choice composer-menu-option\" role=\"menuitemradio\" aria-checked=\"'+String(item.id===selected)+'\" data-project-model-choice=\"'+String(item.id).replace(/&/g,'&amp;').replace(/\\\"/g,'&quot;')+'\"><span>'+item.label+'</span><i class=\"codicon codicon-'+(item.id===selected?'check':'blank')+'\"></i></button>';});sub.innerHTML=html;sub.hidden=false;positionModelSubmenu();}"
    + "document.addEventListener('click',function(event){var target=event.target;if(!target||!target.closest)return;var trigger=target.closest('[data-project-model-trigger]');if(trigger){var menu=trigger.parentElement&&trigger.parentElement.querySelector('[data-project-model-menu]');if(menu){var open=!menu.hidden;closeModelMenu();menu.hidden=open;trigger.setAttribute('aria-expanded',String(!open));if(!open)positionModelSubmenu();}return;}var category=target.closest('[data-project-model-category]');if(category&&!category.disabled){showModelChoices(category);return;}var choice=target.closest('[data-project-model-choice]');if(choice){var value=choice.getAttribute('data-project-model-choice')||'';var sub=choice.closest('[data-project-model-submenu]');var menu=sub&&sub.closest('[data-project-model-menu]');var heading=sub&&sub.querySelector('.project-model-submenu-heading');var kind=heading&&heading.textContent==='Reasoning'?'reasoning':heading&&heading.textContent==='Speed'?'speed':'model';var categoryButton=menu&&menu.querySelector('[data-project-model-category=\"'+kind+'\"]');var valueNode=categoryButton&&categoryButton.querySelector('[data-project-model-value]');if(valueNode)valueNode.textContent=choice.querySelector('span')?.textContent||'CLI setting';if(categoryButton)categoryButton.setAttribute('data-selected',value);if(kind==='model'){var modelCategory=menu&&menu.querySelector('[data-project-model-category=\"model\"]');var modelItems=[];try{modelItems=JSON.parse(modelCategory.getAttribute('data-items')||'[]');}catch(_){}var chosen=modelItems.find(function(item){return item.id===value;})||{};['reasoning','speed'].forEach(function(name){var button=menu.querySelector('[data-project-model-category=\"'+name+'\"]');if(!button)return;var values=chosen[name==='reasoning'?'reasoningEfforts':'speedTiers']||[];button.setAttribute('data-items',JSON.stringify(values.map(function(id){return {id:id,label:id};})));button.disabled=!values.length;button.setAttribute('data-selected','');var node=button.querySelector('[data-project-model-value]');if(node)node.textContent='CLI setting';});var caps=menu.parentElement&&menu.parentElement.querySelector('[data-project-model-capabilities]');if(caps){var rs=menu.querySelector('[data-project-model-category=\"reasoning\"]'),ss=menu.querySelector('[data-project-model-category=\"speed\"]');var rv=rs&&JSON.parse(rs.getAttribute('data-items')||'[]').map(function(i){return i.label;}).join(' / '),sv=ss&&JSON.parse(ss.getAttribute('data-items')||'[]').map(function(i){return i.label;}).join(' / ');caps.textContent=[rv?'Reasoning: '+rv:'',sv?'Speed: '+sv:''].filter(Boolean).join(' · ');caps.hidden=!caps.textContent;}var trigger=menu&&menu.parentElement&&menu.parentElement.querySelector('[data-project-model-trigger]');if(trigger){trigger.value=value;var tv=trigger.querySelector('[data-project-model-value]');if(tv)tv.textContent=choice.querySelector('span')?.textContent||'Use CLI default';}api.postMessage({type:'projectAiModel',model:value||undefined});}else{var caps=menu&&menu.parentElement&&menu.parentElement.querySelector('[data-project-model-capabilities]');if(caps){var rButton=menu.querySelector('[data-project-model-category=\"reasoning\"]'),sButton=menu.querySelector('[data-project-model-category=\"speed\"]');caps.textContent='Reasoning: '+(rButton&&rButton.getAttribute('data-selected')||'CLI setting')+' · Speed: '+(sButton&&sButton.getAttribute('data-selected')||'CLI setting');caps.hidden=false;}if(kind==='reasoning'){api.postMessage({type:'projectAiReasoning',reasoningEffort:value||undefined});}else{api.postMessage({type:'projectAiSpeed',speed:value||undefined});}}closeModelMenu();return;}if(!target.closest('[data-project-model-menu]'))closeModelMenu();});"
    + "document.addEventListener(\"click\",function(event){var target=event.target;"
    // The panel root also carries data-project-page for restoration/state. Restrict
    // navigation clicks to the actual tab buttons; otherwise clicking any child
    // control (especially a native <select>) bubbles to the root, posts a page
    // message, and the host replaces the document while the popup is opening.
    + "var element=target&&target.closest?target.closest(\"button[data-project-page],[data-draft-action],[data-project-initialize]\"):null;"
    + "if(!element)return;var page=element.getAttribute(\"data-project-page\");"
    + "if(page){api.postMessage({type:\"projectPage\",page:page});return;}"
    + "if(element.hasAttribute('data-project-initialize')){var b=element;b.disabled=true;b.textContent='Initializing…';api.postMessage({type:'projectInitialize'});return;}"
    + ""
    + "var action=element.getAttribute(\"data-draft-action\");"
    + "if(action){api.postMessage({type:\"projectDraft\",action:action,id:element.getAttribute(\"data-draft-id\")});}});"
    + "document.addEventListener('change',function(event){var target=event.target;if(!target||!target.matches)return;if(target.matches('[data-project-ai-cli]')){var option=target.options[target.selectedIndex],models=[];try{models=JSON.parse(option.getAttribute('data-models')||'[]');}catch(_){}var old=document.querySelector('.project-ai-model');if(old)old.remove();if(models.length&&target.value){var wrap=document.createElement('div');wrap.innerHTML='<label class=\"project-ai-model\">Model for Project initialization <div class=\"project-ai-model-control\"><button type=\"button\" class=\"project-model-trigger\" data-project-ai-model data-project-model-trigger aria-expanded=\"false\"><span>Model</span><strong data-project-model-value=\"model\">Use CLI default</strong><i class=\"codicon codicon-chevron-down\"></i></button><small class=\"project-model-capabilities\" data-project-model-capabilities hidden></small><div class=\"project-model-popover composer-model-popover\" data-project-model-menu hidden></div></div></label>';var control=wrap.firstElementChild;var menu=control.querySelector('[data-project-model-menu]');var make=function(id,label,items,disabled){return '<button type=\"button\" class=\"project-model-category composer-menu-option composer-menu-category\" data-project-model-category=\"'+id+'\" data-selected=\"\" data-items=\"'+JSON.stringify(items).replace(/\"/g,'&quot;')+'\"'+(disabled?' disabled':'')+'><span>'+label+'</span><span class=\"project-model-category-value\" data-project-model-value=\"'+id+'\">CLI setting</span><i class=\"codicon codicon-chevron-right\"></i></button>';};menu.innerHTML=make('model','Model',[{id:'',label:'Use CLI default'}].concat(models.map(function(m){return {id:m.id,label:m.label,group:m.group||'',reasoningEfforts:m.reasoningEfforts||[],speedTiers:m.speedTiers||[]};})),false)+make('reasoning','Reasoning',[],true)+make('speed','Speed',[],true)+'<div class=\"project-model-submenu composer-model-submenu\" data-project-model-submenu hidden></div>';target.closest('.project-ai-cli').insertAdjacentElement('afterend',control);}api.postMessage({type:'projectAiCli',cli:target.value||undefined});}});"
    + "var elapsedTimer=0;function updateElapsed(){var box=document.querySelector('[data-project-init-progress]'),node=box&&box.querySelector('[data-project-init-elapsed]'),started=box&&Number(box.getAttribute('data-project-init-started-at'));if(!node||!started)return;var seconds=Math.max(0,Math.floor((Date.now()-started)/1000)),minutes=Math.floor(seconds/60);node.textContent='· '+(minutes?minutes+'m '+(seconds%60)+'s':seconds+'s');}updateElapsed();if(document.querySelector('[data-project-init-progress][data-project-init-started-at]'))elapsedTimer=window.setInterval(updateElapsed,1000);"
    + "window.addEventListener('message',function(event){var message=event&&event.data;if(!message||message.type!=='projectInitializationProgress')return;var state=message.state||{},box=document.querySelector('[data-project-init-progress]');if(!box)return;if(state.startedAt!==undefined)box.setAttribute('data-project-init-started-at',String(state.startedAt));if(state.status!=='running'&&elapsedTimer){window.clearInterval(elapsedTimer);elapsedTimer=0;}var label=box.querySelector('[data-project-progress-label]'),meter=box.querySelector('progress'),count=box.querySelector('[data-project-progress-count]'),output=box.querySelector('[data-project-init-output]');var phase=state.phase==='generating'?'AI generation':state.phase==='saving'?'Validating and saving':'Preparing bounded text evidence';if(label)label.textContent='Initializing project knowledge · '+phase+(state.message?' · '+state.message:'');updateElapsed();if(meter){if(state.progress!==undefined&&state.progressTotal){meter.max=state.progressTotal;meter.value=state.progress;}else{meter.removeAttribute('value');}}if(count){if(state.progress!==undefined&&state.progressTotal){count.hidden=false;count.textContent=state.progress+'/'+state.progressTotal;}else{count.hidden=true;}}if(output){if(state.output){output.hidden=false;output.textContent=state.output;}else if(state.status==='running'){output.hidden=true;}}});"
    // Navigating from an adopted suggestion marks the object it wrote.
    + "var focus=document.querySelector('[data-project-focus]');"
    + "if(focus){var id=focus.getAttribute('data-project-focus');"
    + "var row=id?document.querySelector('[data-object-id=\"'+id+'\"]'):null;"
    + "if(row){row.classList.add('project-object-focus');row.scrollIntoView({block:'center'});}"
    + "}"
    + "})();</script>";
}

/**
 * Renders one Project page. Only long-term objects and saved semantic diagrams are emitted;
 * conversation execution logs, Hook output, and single-run Review never appear here.
 */
export function renderProjectPanel(page: ProjectPanelPage, data: ProjectPanelData, options: { focusObjectId?: string; state?: EditorTabState } = {}): string {
  const body = page === "overview" ? renderOverview(data.overview)
    : page === "knowledge" ? renderKnowledge(data.objects, data.drafts ?? [], data.knowledge)
      : renderArchitectureView(data.architecture);
  const focus = options.focusObjectId
    ? `<span class="project-focus" data-project-focus="${escapeHtml(options.focusObjectId)}"></span>`
    : "";
  return `<div class="project-panel" data-project-page="${page}">${renderProjectNav(page)}<main class="project-body">${focus}${body}</main></div>${projectPanelScript(options.state)}${projectDiagramScript()}`;
}
