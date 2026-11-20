import type { ApplyResult, DextResult } from "../../../shared/contracts/types.js";
import type { TurnModePresentation, TurnRenderModel } from "./turnPresentation.js";
import { uiResultText } from "./uiInteractionPresentation.js";
import type { AgentMessagePresentation } from "./agentMessagePresentation.js";
import { formatJsonOutput } from "../../../shared/lib/jsonOutput.js";
import { renderUiView } from "../../../shared/lib/ui/uiViewPresentation.js";
import type { MarkupAdapter, UiRenderAdapter } from "../../../shared/lib/ui/renderAdapter.js";
import {
  CodeBlock, Text, TraceChevron, TraceCollapsible, TraceCollapsibleContent,
  TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle
} from "../../../shared/lib/ui/traceComponents.js";

/** The process line: one light `Worked …` row that unfolds into the timeline.
 * It never renders a section label of its own. */
export function renderTurnSection<E>(
  adapter: UiRenderAdapter<E>, process: TurnRenderModel["process"], children: readonly E[] = [],
  open = false, action?: E
): { disclosure: E; body: E; meta: E; summary: E } {
  const el = adapter.element;
  const meta = TraceDescription(adapter, [process.detail ?? ""], { class: "turn-section-meta disclosure-meta" });
  const summary = TraceCollapsibleTrigger(adapter, [
    TraceChevron(adapter),
    meta,
    ...(action ? [el("span", { class: "turn-section-actions" }, [action])] : [])
  ]);
  const content = TraceCollapsibleContent(adapter, children, { class: "turn-section-body" }, "div");
  return {
    disclosure: TraceCollapsible(adapter, summary, content, { class: "turn-section", "data-turn-section": "process", open }),
    body: content[0]!, meta, summary
  };
}

/** The answer is never a fold target: one divider separates it from the timeline. */
export function renderTurnOutput<E>(adapter: UiRenderAdapter<E>, children: readonly E[], copy?: E): { section: E; body: E } {
  const el = adapter.element;
  const body = el("div", { class: "turn-output-body" }, children);
  return {
    section: el("section", { class: "turn-output", "data-turn-section": "output" }, [...(copy ? [copy] : []), body]),
    body
  };
}

/** The submitted mode is plain metadata beside the prompt, not a pill. */
export function renderTurnMode<E>(adapter: UiRenderAdapter<E>, mode: TurnModePresentation): E {
  return adapter.element("span", { class: "turn-mode", "data-mode": mode.value, title: mode.title }, [mode.label]);
}

/** Copy controls belong to the section title bar, not to the content they copy. */
export function renderTurnMarkdown<E>(adapter: UiRenderAdapter<E>, body: E): E {
  return adapter.element("div", { class: "output-text-copyable" }, [body]);
}

/** A literal JSON view shared by both hosts. Copy always receives the raw source
 * and sits in the JSON title bar, so it stays exact even when Output has more
 * than one result. */
export function renderTurnJson<E>(adapter: UiRenderAdapter<E>, text: string, copy?: E): E | undefined {
  const formatted = formatJsonOutput(text);
  if (formatted === undefined) return undefined;
  const summary = TraceCollapsibleTrigger(adapter, [TraceChevron(adapter), Text("JSON"), ...(copy ? [copy] : [])]);
  const content = TraceCollapsibleContent(adapter, [CodeBlock(adapter, formatted, { class: "json-output-text" })]);
  return adapter.element("div", { class: "output-text-copyable json-output" }, [
    TraceCollapsible(adapter, summary, content, { class: "execution-disclosure json-disclosure", open: true })
  ]);
}

export function renderTurnDisclosureSummary<E>(
  adapter: UiRenderAdapter<E>, label: string, detail: string, detailClass = "disclosure-meta"
): E {
  return TraceCollapsibleTrigger(adapter, [
    TraceChevron(adapter), TraceTitle(adapter, [label]), TraceDescription(adapter, [detail], { class: detailClass })
  ]);
}

export interface TurnResultAdapter<E> extends MarkupAdapter<E> {
  markdown(text: string): E;
  json(text: string): E;
  plan(path: string): E;
}

/** One result dispatch and layout policy for History and Conversation. Host actions
 * (open a plan, copy output) remain callbacks on the adapters. */
export function renderTurnResult<E>(adapter: TurnResultAdapter<E>, result: DextResult, patchApplication?: ApplyResult): E[] {
  const textOutput = (text: string): E => formatJsonOutput(text) === undefined ? adapter.markdown(text) : adapter.json(text);
  if (result.kind === "ask" || result.kind === "plan" || result.kind === "skill" || result.kind === "template") {
    return [textOutput(result.text), ...(result.kind === "plan" && result.planPath ? [adapter.plan(result.planPath)] : [])];
  }
  if (result.kind === "agent") return [
    ...(result.text ? [textOutput(result.text)] : []),
    ...(patchApplication ? [adapter.element("div", {
      class: `patch-application ${patchApplication.status}`,
      role: patchApplication.status === "conflict" ? "alert" : "status"
    }, [patchApplication.status === "applied"
      ? `Automatically applied changes to ${patchApplication.files.length} file${patchApplication.files.length === 1 ? "" : "s"}.`
      : `Auto-apply ${patchApplication.status}: ${patchApplication.summary}`])] : result.patch ? [adapter.element("div", {
      class: "patch-application ignored", role: "status"
    }, ["Legacy patch ignored; no files were written when loading this conversation."])] : [])
  ];
  if (result.kind === "apply") return [adapter.markdown(`${result.status}: ${result.summary}`)];
  // terminal 的返回值是给 API 读的，不进 Output；要给人看就由 API 自己 console.log。
  if (result.kind === "terminal") return [];
  if (result.kind === "ui") return [adapter.markdown(uiResultText(result))];
  if (result.kind === "view") {
    const tree = renderUiView(adapter, result);
    return tree === undefined ? [] : [tree];
  }
  // 没有 kind 的普通返回值同样不进 Output：要给人看就由 API 自己 console.log。
  const declared = typeof (result as { kind?: unknown }).kind === "string";
  return declared ? [adapter.json(JSON.stringify(result, null, 2))] : [];
}

export interface TurnMessageAdapter<E> extends UiRenderAdapter<E> {
  prose(text: string): E;
  code(text: string): E;
}

/** Process messages share structure too; the live view only owns when to update them. */
export function renderTurnMessage<E>(adapter: TurnMessageAdapter<E>, message: AgentMessagePresentation): E[] {
  if (!message.structured) return [adapter.prose(message.text)];
  const el = adapter.element;
  const disclosure = (label: string, detail: string, className: string, children: E[]): E =>
    TraceCollapsible(adapter, renderTurnDisclosureSummary(adapter, label, detail),
      TraceCollapsibleContent(adapter, children), { class: className });
  return [el("section", { class: `agent-result process-result-${message.kind}` }, [
    el("div", { class: "agent-result-heading" }, [
      TraceTitle(adapter, [message.title], { class: "agent-result-title" }),
      ...(message.meta.length ? [TraceDescription(adapter, [message.meta.join(" · ")], { class: "agent-result-meta" })] : [])
    ]),
    ...(message.text ? [adapter.prose(message.text)] : []),
    ...message.details.map((detail) => TraceLine(adapter, [
      ...(detail.meta ? [TraceDescription(adapter, [detail.meta], { class: "agent-result-detail-meta" })] : []), Text(detail.text)
    ], { class: `agent-result-detail ${detail.tone}`, role: false }, "div")),
    ...message.references.map((reference) => disclosure(reference.uri.replaceAll("\\", "/").split("/").pop() ?? reference.uri,
      [reference.location, reference.symbol].filter(Boolean).join(" · "), "agent-result-reference", [
        el("div", { class: "agent-file-path" }, [reference.uri]),
        ...(reference.content ? [adapter.code(reference.content)] : [])
      ])),
    ...message.sections.map((section) => disclosure(section.title, "", `agent-result-section ${section.tone}`, [
      el("div", { class: "agent-result-section-body" }, [section.code ? adapter.code(section.text) : adapter.prose(section.text)])
    ]))
  ])];
}

