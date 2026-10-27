import type { ProjectDiagram } from "../contracts/projectDiagram.js";
import type { ProjectTopic } from "../knowledge/projectTopics.js";
import { projectPlaybackSteps } from "../presentation/projectDiagramPresentation.js";
import { escapeProjectHtml as esc, readerGalleryArticle, readerIntroduction, readerTopicArticle, topicDiagrams, type ProjectReaderData } from "../presentation/projectTopicsView.js";
import { isTrustedHostMessage } from "./archifyBridge.js";
import { renderReaderArchify, type ReaderArchifyView } from "./projectReaderArchify.js";

export interface ReaderApi { postMessage(message: unknown): void; getState?(): { filters?: Record<string, string> } | undefined; setState?(state: unknown): void }

export function startProjectReader(root: HTMLElement, api: ReaderApi): void {
  const template = root.querySelector<HTMLTemplateElement>("[data-project-reader-data]");
  if (!template) return;
  let data = JSON.parse(template.content.textContent ?? "{}") as ProjectReaderData;
  const article = root.querySelector<HTMLElement>("[data-reader-article]")!;
  const progress = root.querySelector<HTMLElement>("[data-reader-progress]")!;
  let topic: ProjectTopic | undefined;
  let diagram: ProjectDiagram | undefined;
  let generation = 0;
  let busy = false;
  let generationFailed = false;
  let interactive: ReaderArchifyView | undefined;
  let fullscreenFigure: HTMLElement | undefined;
  let fullscreenFocus: HTMLElement | undefined;
  let fullscreenRequest = 0;
  let nativeFullscreen = false;
  let playbackTimer: number | undefined;
  let playbackIndex = -1;
  const stopPlayback = () => { if (playbackTimer !== undefined) clearInterval(playbackTimer); playbackTimer = undefined; const button = article.querySelector("[data-reader-play]"); if (button) button.textContent = "Play steps"; };

  const saveSelection = () => {
    const previous = api.getState?.();
    api.setState?.({ ...previous, filters: { ...previous?.filters, topic: topic?.id ?? "", diagram: diagram?.id ?? "" } });
  };
  const markDirectory = () => root.querySelectorAll<HTMLButtonElement>(".project-reader-directory button").forEach((button) => {
    const active = topic ? button.dataset.readerTopic === topic.id : button.dataset.readerDiagram === diagram?.id;
    button.setAttribute("aria-current", active ? "page" : "false");
    const group = button.closest<HTMLDetailsElement>("[data-reader-area]");
    if (active && group) group.open = true;
  });
  const setInteractiveControls = (enabled: boolean) => {
    article.querySelectorAll<HTMLButtonElement>("[data-reader-zoom], [data-reader-export]").forEach((button) => { button.disabled = !enabled; });
  };
  const exitFullscreen = (restoreFocus = true) => {
    const figure = fullscreenFigure;
    if (!figure) return;
    fullscreenRequest++;
    fullscreenFigure = undefined; nativeFullscreen = false;
    figure.classList.remove("is-fullscreen");
    document.body.classList.remove("project-reader-fullscreen");
    const button = figure.querySelector<HTMLButtonElement>("[data-reader-screen]");
    if (button) { button.textContent = "Fullscreen"; button.setAttribute("aria-pressed", "false"); }
    const expand = figure.querySelector<HTMLButtonElement>("[data-reader-fullscreen]");
    if (expand) expand.disabled = false;
    if (document.fullscreenElement === figure) void document.exitFullscreen().catch(() => undefined);
    interactive?.command("fullscreen", { active: figure.classList.contains("is-expanded") });
    if (restoreFocus && fullscreenFocus?.isConnected) fullscreenFocus.focus({ preventScroll: true });
    fullscreenFocus = undefined;
  };
  const enterFullscreen = async () => {
    if (fullscreenFigure) { exitFullscreen(); return; }
    const figure = article.querySelector<HTMLElement>(".project-reader-figure");
    if (!figure) return;
    const owner = ++fullscreenRequest;
    fullscreenFigure = figure;
    fullscreenFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    figure.classList.add("is-fullscreen");
    document.body.classList.add("project-reader-fullscreen");
    const button = figure.querySelector<HTMLButtonElement>("[data-reader-screen]")!;
    button.textContent = "Exit fullscreen"; button.setAttribute("aria-pressed", "true");
    figure.querySelector<HTMLButtonElement>("[data-reader-fullscreen]")!.disabled = true;
    interactive?.command("fullscreen", { active: true });
    // VS Code may disallow the native API on its containing iframe. The viewport layout still works.
    try { await figure.requestFullscreen?.(); } catch { /* Keep the fullscreen Webview layout. */ }
    if (owner !== fullscreenRequest || fullscreenFigure !== figure || !figure.isConnected) {
      if (fullscreenFigure !== figure && document.fullscreenElement === figure) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    nativeFullscreen = document.fullscreenElement === figure;
  };
  const closePresentation = () => {
    stopPlayback();
    if (fullscreenFigure) { exitFullscreen(); return; }
    article.querySelector(".is-expanded")?.classList.remove("is-expanded");
    interactive?.command("fullscreen", { active: false });
    const button = article.querySelector("[data-reader-fullscreen]");
    if (button) button.textContent = "Expand";
  };
  const highlight = (semanticIds: readonly string[], elementId?: string) => {
    article.querySelectorAll<HTMLElement>("[data-reader-section]").forEach((node) => node.classList.toggle("is-selected", semanticIds.includes(node.dataset.readerSection ?? "")));
    article.querySelectorAll<SVGElement>("[data-reader-element]").forEach((node) => node.classList.toggle("is-selected", node.dataset.readerElement === elementId));
  };
  const inspect = (id: string, kind: "node" | "relation") => {
    if (!diagram) return;
    const node = kind === "node" ? diagram.nodes.find((node) => node.id === id) : undefined;
    const relation = kind === "relation" ? diagram.relations.find((relation) => relation.id === id) : undefined;
    const item = node ?? relation;
    if (!item) return;
    const semanticIds = node ? [node.id, ...node.semanticIds] : diagram.nodes.filter((node) => node.id === relation?.from || node.id === relation?.to).flatMap((node) => node.semanticIds);
    const sections = topic?.sections?.filter((section) => semanticIds.includes(section.id)) ?? [];
    highlight(semanticIds, id);
    interactive?.command("select", { nodeId: node?.id ?? relation?.to });
    const inspector = article.querySelector<HTMLElement>("[data-reader-inspector]")!;
    inspector.hidden = false;
    const related = data.topics.filter((candidate) => candidate.id !== topic?.id && (semanticIds.includes(candidate.id) || sections.some((section) => section.relatedTopicIds.includes(candidate.id))));
    const title = node?.label ?? `${diagram.nodes.find((node) => node.id === relation?.from)?.label ?? relation?.from} → ${diagram.nodes.find((node) => node.id === relation?.to)?.label ?? relation?.to}`;
    const transition = diagram.semantics?.transitions?.find((transition) => transition.relationId === relation?.id);
    const message = diagram.semantics?.messages?.find((message) => message.relationId === relation?.id);
    const description = node ? node.description || sections.map((section) => section.description).filter(Boolean).join(" ")
      : relation?.label || transition?.event || relation?.kind.replaceAll("_", " ") || "";
    const condition = transition?.condition ?? message?.condition ?? relation?.condition;
    const provenance = typeof relation?.metadata?.provenance === "string" ? relation.metadata.provenance : undefined;
    const reverse = relation?.metadata?.structureMatch === "reverse";
    inspector.innerHTML = `<button type="button" class="project-reader-inspector-close" data-reader-inspector-close aria-label="Close details" title="Close details">&times;</button><strong>${esc(title ?? id)}</strong>${description ? `<p>${esc(description)}</p>` : ""}${condition ? `<p>When: ${esc(condition)}</p>` : ""}${relation?.exception ? "<p>Exception path</p>" : ""}`
      + (provenance ? `<p class="project-help">Structure: ${esc(provenance)}${reverse ? " — opposite to the indexed import direction; review the direction" : ""}</p>` : "")
      + (sections.length ? `<p class="project-help">Linked to the explanation: ${sections.map((section) => esc(section.title)).join(", ")}</p>` : "")
      + `<div class="project-reader-related">${related.map((candidate) => `<button type="button" data-reader-topic="${esc(candidate.id)}">Read ${esc(candidate.title)} →</button>`).join("")}</div>`
      + `<ul class="project-topic-evidence">${item.evidence.map((entry, index) => `<li><button type="button" data-reader-element-source="${esc(id)}" data-element-kind="${kind}" data-evidence-index="${index}">${esc(entry.path)}${entry.line ? `:${entry.line}` : ""}${entry.symbol ? ` · ${esc(entry.symbol)}` : ""}</button>${entry.note ? `<small>${esc(entry.note)}</small>` : ""}</li>`).join("") || "<li>No source reference was saved for this element.</li>"}</ul>`;
    const explained = Array.from(article.querySelectorAll<HTMLElement>("[data-reader-section]")).find((node) => semanticIds.includes(node.dataset.readerSection ?? ""));
    if (!article.querySelector(".is-expanded, .is-fullscreen")) explained?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const renderConnections = () => {
    const inspector = article.querySelector<HTMLElement>("[data-reader-inspector]");
    article.querySelector("[data-reader-connections]")?.remove();
    if (!diagram?.relations.length || !inspector) return;
    const connections = document.createElement("details");
    connections.dataset.readerConnections = "";
    connections.className = "project-reader-source";
    const summary = document.createElement("summary");
    summary.textContent = `Connections · ${diagram.relations.length}`;
    connections.append(summary);
    for (const relation of diagram.relations) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.readerRelation = relation.id;
      const from = diagram.nodes.find((node) => node.id === relation.from)?.label ?? relation.from;
      const to = diagram.nodes.find((node) => node.id === relation.to)?.label ?? relation.to;
      const provenance = typeof relation.metadata?.provenance === "string" ? ` · ${relation.metadata.provenance}` : "";
      button.textContent = `${from} → ${to}${relation.label ? ` · ${relation.label}` : ""}${provenance}`;
      connections.append(button);
    }
    inspector.after(connections);
  };
  const renderDiagram = async () => {
    const owner = ++generation;
    stopPlayback(); playbackIndex = -1;
    interactive?.dispose(); interactive = undefined;
    const canvas = article.querySelector<HTMLElement>("[data-reader-canvas]");
    const status = article.querySelector<HTMLElement>("[data-reader-render-status]");
    if (!diagram || !canvas || !status) return;
    canvas.replaceChildren();
    const playback = article.querySelector<HTMLElement>("[data-reader-playback]");
    if (playback) playback.hidden = true;
    delete canvas.dataset.renderer;
    canvas.dataset.state = "loading";
    setInteractiveControls(false);
    status.hidden = false;
    status.textContent = "Rendering diagram…";
    const model = article.querySelector<HTMLElement>("[data-reader-diagram-source]");
    if (model) model.textContent = JSON.stringify(diagram, null, 2);
    renderConnections();
    const active = renderReaderArchify(diagram, canvas, (message) => api.postMessage(message), inspect, closePresentation);
    interactive = active;
    try {
      await active.ready;
      if (owner !== generation || !canvas.isConnected) return;
      canvas.dataset.state = "ready"; canvas.dataset.renderer = "archify";
      status.hidden = true;
      active.command("fullscreen", { active: Boolean(canvas.closest(".is-expanded, .is-fullscreen")) });
      article.querySelector<HTMLElement>("[data-reader-playback]")!.hidden = projectPlaybackSteps(diagram).length < 2;
      setInteractiveControls(true);
    } catch (error) {
      if (owner !== generation || !canvas.isConnected) return;
      active.dispose(); interactive = undefined; canvas.replaceChildren();
      canvas.dataset.state = "error";
      delete canvas.dataset.renderer;
      const reason = error instanceof Error ? error.message : String(error);
      status.hidden = false;
      status.textContent = `Diagram unavailable: ${reason.length > 240 ? `${reason.slice(0, 239)}…` : reason}. The explanation and evidence remain available.`;
      const details = article.querySelector<HTMLDetailsElement>("[data-reader-diagram-source]")?.closest("details");
      if (details) details.open = true;
      setInteractiveControls(false);
    }
  };
  const selectTopic = (id: string, diagramId?: string) => {
    const next = data.topics.find((candidate) => candidate.id === id);
    if (!next) return;
    exitFullscreen(false);
    topic = next;
    const available = topicDiagrams(next, data.diagrams);
    diagram = available.find((candidate) => candidate.id === diagramId) ?? available[0];
    article.innerHTML = readerTopicArticle(next, data);
    article.querySelectorAll<HTMLButtonElement>("[data-topic-diagram]").forEach((button) => { button.disabled = busy; });
    const select = article.querySelector<HTMLSelectElement>("[data-reader-view]");
    if (select && diagram) select.value = diagram.id;
    markDirectory(); saveSelection(); void renderDiagram();
  };
  const selectDiagram = (id: string) => {
    const next = data.diagrams.find((candidate) => candidate.id === id);
    if (!next) return;
    exitFullscreen(false);
    topic = undefined; diagram = next;
    article.innerHTML = readerGalleryArticle(next, data);
    markDirectory(); saveSelection(); void renderDiagram();
  };
  const selectIntroduction = () => {
    exitFullscreen(false);
    stopPlayback(); interactive?.dispose(); interactive = undefined;
    generation++; topic = undefined; diagram = undefined;
    article.innerHTML = readerIntroduction(data);
    markDirectory(); saveSelection();
  };
  root.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-project-topic-search]")) return;
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLButtonElement>("[data-topic-search]").forEach((button) => { button.hidden = !button.dataset.topicSearch?.includes(query); if (!button.hidden) visible++; });
    root.querySelectorAll<HTMLDetailsElement>("[data-reader-area]").forEach(group => {
      group.hidden = !group.querySelector("[data-topic-search]:not([hidden])");
      if (query && !group.hidden) group.open = true;
    });
    root.querySelector<HTMLElement>("[data-project-topic-empty]")!.hidden = visible > 0;
  });
  root.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches("[data-reader-view]")) return;
    diagram = (topic ? topicDiagrams(topic, data.diagrams) : data.diagrams).find((candidate) => candidate.id === select.value);
    article.querySelector<HTMLElement>("[data-reader-inspector]")!.hidden = true;
    highlight([]); saveSelection(); void renderDiagram();
  });
  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!button) return;
    if (button.hasAttribute("data-reader-inspector-close")) {
      article.querySelector<HTMLElement>("[data-reader-inspector]")!.hidden = true;
      highlight([]);
      interactive?.command("select", { nodeId: "" });
      article.querySelector<HTMLSelectElement>("[data-reader-view]")?.focus();
      return;
    }
    if (button.dataset.readerTopic) selectTopic(button.dataset.readerTopic);
    if (button.dataset.readerDiagram) selectDiagram(button.dataset.readerDiagram);
    if (button.hasAttribute("data-reader-home")) {
      selectIntroduction();
    }
    if (button.dataset.readerStep && topic) {
      stopPlayback();
      const id = button.dataset.readerStep;
      let node = diagram?.nodes.find((candidate) => candidate.semanticIds.includes(id));
      if (!node && topic.diagram) {
        diagram = topic.diagram;
        const select = article.querySelector<HTMLSelectElement>("[data-reader-view]");
        if (select) select.value = diagram.id;
        node = diagram.nodes.find((candidate) => candidate.semanticIds.includes(id));
        const selectedNode = node;
        const ownerTopic = topic.id;
        const ownerDiagram = diagram.id;
        saveSelection();
        void renderDiagram().then(() => { if (selectedNode && topic?.id === ownerTopic && diagram?.id === ownerDiagram) inspect(selectedNode.id, "node"); });
      } else if (node) inspect(node.id, "node");
      else highlight([id]);
    }
    if (button.dataset.readerRelation) inspect(button.dataset.readerRelation, "relation");
    if (button.dataset.topicEvidence) api.postMessage({ type: "projectTopicEvidence", topicId: button.dataset.topicEvidence, evidenceIndex: Number(button.dataset.evidenceIndex) });
    if (button.dataset.readerElementSource && diagram) api.postMessage({ type: "projectReaderEvidence", diagramId: diagram.id, updatedAt: diagram.updatedAt, elementId: button.dataset.readerElementSource, elementKind: button.dataset.elementKind, evidenceIndex: Number(button.dataset.evidenceIndex) });
    if (button.hasAttribute("data-project-check-knowledge")) { button.disabled = true; api.postMessage({ type: "projectKnowledgeCheck" }); }
    if (button.dataset.topicDiagram && !busy) { busy = true; button.disabled = true; api.postMessage({ type: "projectTopicDiagram", topicId: button.dataset.topicDiagram }); }
    if (button.dataset.readerZoom) {
      interactive?.command(button.dataset.readerZoom === "fit" ? "reset" : button.dataset.readerZoom === "in" ? "zoom-in" : "zoom-out");
    }
    if (button.hasAttribute("data-reader-fullscreen")) {
      const figure = article.querySelector<HTMLElement>(".project-reader-figure");
      if (figure) { figure.classList.toggle("is-expanded"); button.textContent = figure.classList.contains("is-expanded") ? "Close" : "Expand"; interactive?.command("fullscreen", { active: figure.classList.contains("is-expanded") }); }
    }
    if (button.hasAttribute("data-reader-screen")) void enterFullscreen();
    if (button.hasAttribute("data-reader-export") && interactive) {
      interactive.command("export-svg");
      return;
    }
    if ((button.hasAttribute("data-reader-play") || button.hasAttribute("data-reader-next")) && diagram && interactive) {
      const steps = projectPlaybackSteps(diagram);
      const advance = () => {
        playbackIndex++;
        const step = steps[playbackIndex];
        if (!step) { stopPlayback(); playbackIndex = -1; return; }
        inspect(step.id, step.kind);
        article.querySelector<HTMLElement>("[data-reader-play-status]")!.textContent = `Step ${playbackIndex + 1} / ${steps.length}`;
      };
      if (button.hasAttribute("data-reader-next")) { stopPlayback(); advance(); }
      else if (playbackTimer !== undefined) stopPlayback();
      else { if (playbackIndex >= steps.length - 1) playbackIndex = -1; advance(); button.textContent = "Pause"; playbackTimer = window.setInterval(advance, 1800); }
    }
    if (button.hasAttribute("data-reader-cancel")) api.postMessage({ type: "projectDiagramCancel" });
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePresentation(); });
  document.addEventListener("fullscreenchange", () => {
    if (!fullscreenFigure) return;
    if (document.fullscreenElement === fullscreenFigure) nativeFullscreen = true;
    else if (nativeFullscreen) exitFullscreen();
  });
  window.addEventListener("message", (event: MessageEvent<{ type?: string; checks?: ProjectReaderData["checks"]; topics?: ProjectReaderData["topics"]; error?: string; message?: string; active?: boolean; document?: ProjectDiagram; cancelled?: boolean; fileName?: string }>) => {
    const message = event.data;
    if (!message || !isTrustedHostMessage(event.source, article.querySelector<HTMLIFrameElement>("iframe")?.contentWindow, message)) return;
    if (message.type === "projectKnowledgeChecked") {
      const openDetails = Array.from(article.querySelectorAll<HTMLDetailsElement>("details[open]")).map((details) => details.querySelector("summary")?.textContent);
      if (message.checks) data = { ...data, checks: message.checks };
      if (topic) selectTopic(topic.id, diagram?.id);
      article.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => { details.open = openDetails.includes(details.querySelector("summary")?.textContent); });
      const status = article.querySelector<HTMLElement>("[data-project-check-status]");
      if (status) status.textContent = message.error || "Sources checked. See the recorded check time and any review warning above.";
      const button = article.querySelector<HTMLButtonElement>("[data-project-check-knowledge]"); if (button) button.disabled = false;
    }
    if (message.type === "projectDiagramGenerating") {
      busy = Boolean(message.active);
      if (busy) generationFailed = false;
      progress.hidden = !busy && !generationFailed;
      if (busy) progress.innerHTML = `Analyzing module and generating its explanation… <button type="button" data-reader-cancel>Cancel</button>`;
      article.querySelectorAll<HTMLButtonElement>("[data-topic-diagram]").forEach((button) => { button.disabled = busy; });
    }
    if (message.type === "projectDiagramProgress") { progress.hidden = false; progress.innerHTML = `${esc(message.message ?? "Generating…")} <button type="button" data-reader-cancel>Cancel</button>`; }
    if (message.type === "projectDiagramGenerateFailed" || message.type === "projectDiagramExportFailed") {
      generationFailed = true;
      if (message.type === "projectDiagramGenerateFailed") busy = false;
      progress.hidden = false; progress.textContent = message.error ?? "The operation failed.";
      article.querySelectorAll<HTMLButtonElement>("[data-topic-diagram]").forEach((button) => { button.disabled = busy; });
    }
    if (message.type === "projectDiagramExported") { progress.hidden = false; progress.textContent = message.cancelled ? "Export cancelled." : `SVG exported${message.fileName ? `: ${message.fileName}` : "."}`; }
    if (message.type === "projectDiagramGenerated" && message.document) {
      const next = message.document;
      data = { ...data, topics: message.topics ?? data.topics, diagrams: [...data.diagrams.filter((candidate) => candidate.id !== next.id), next] };
      let gallery = root.querySelector<HTMLElement>(".project-reader-gallery");
      if (!gallery) { gallery = document.createElement("details"); gallery.className = "project-reader-gallery"; root.querySelector(".project-reader-directory")!.append(gallery); }
      gallery.innerHTML = `<summary>All saved diagrams · ${data.diagrams.length}</summary>${data.diagrams.map((candidate) => `<button type="button" data-reader-diagram="${esc(candidate.id)}">${esc(candidate.title)}</button>`).join("")}`;
      if (topic) selectTopic(topic.id, next.metadata?.topicId === topic.id ? next.id : diagram?.id);
      else if (diagram?.id === next.id) selectDiagram(next.id);
    }
  });
  const filters = api.getState?.()?.filters;
  const focused = document.querySelector<HTMLElement>("[data-project-focus]")?.dataset.projectFocus;
  if (focused && data.topics.some(item => item.id === focused)) selectTopic(focused);
  else if (!data.gallery && filters?.topic && data.topics.some((topic) => topic.id === filters.topic)) selectTopic(filters.topic, filters.diagram);
  else if (data.gallery && data.diagrams.length) selectDiagram(data.selectedDiagramId ?? data.diagrams[0]!.id);
  else if (filters?.diagram && data.diagrams.some((diagram) => diagram.id === filters.diagram)) selectDiagram(filters.diagram);
  else if (filters?.topic === "" && !filters.diagram) selectIntroduction();
  else if (data.topics[0]) selectTopic(data.topics[0].id);
  else if (data.diagrams[0]) selectDiagram(data.diagrams[0].id);
}
